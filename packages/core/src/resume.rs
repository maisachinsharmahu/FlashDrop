//! Crash-safe transfer state used to continue large files after a process or
//! network restart.
//!
//! The journal only records metadata and acknowledged byte offsets. File
//! content and device secrets never enter the journal. A receiver must still
//! authenticate the peer certificate before accepting a resumed session.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

const JOURNAL_VERSION: u8 = 1;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferJournal {
    pub version: u8,
    pub transfer_id: String,
    pub peer_fingerprint: String,
    pub direction: TransferDirection,
    pub updated_at_unix_ms: u64,
    pub files: BTreeMap<String, ResumableFile>,
}

impl TransferJournal {
    pub fn new(
        transfer_id: String,
        peer_fingerprint: String,
        direction: TransferDirection,
        updated_at_unix_ms: u64,
    ) -> Self {
        Self {
            version: JOURNAL_VERSION,
            transfer_id,
            peer_fingerprint,
            direction,
            updated_at_unix_ms,
            files: BTreeMap::new(),
        }
    }

    pub fn validate(&self) -> Result<(), JournalError> {
        if self.version != JOURNAL_VERSION {
            return Err(JournalError::UnsupportedVersion(self.version));
        }
        if self.transfer_id.is_empty() || self.peer_fingerprint.is_empty() {
            return Err(JournalError::Invalid(
                "missing transfer identity".to_string(),
            ));
        }
        for (id, file) in &self.files {
            if id.is_empty() || file.name.is_empty() {
                return Err(JournalError::Invalid("missing file identity".to_string()));
            }
            if file.committed_bytes > file.size {
                return Err(JournalError::Invalid(format!(
                    "file {id} commits {} bytes but is only {} bytes",
                    file.committed_bytes, file.size
                )));
            }
            if file.status == ResumeFileStatus::Complete && file.committed_bytes != file.size {
                return Err(JournalError::Invalid(format!(
                    "file {id} is complete without a full committed length"
                )));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferDirection {
    Send,
    Receive,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumableFile {
    pub name: String,
    pub size: u64,
    pub committed_bytes: u64,
    pub sha256: Option<String>,
    pub status: ResumeFileStatus,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResumeFileStatus {
    Pending,
    Transferring,
    Paused,
    Complete,
    Failed,
}

#[derive(Debug, thiserror::Error)]
pub enum JournalError {
    #[error("journal I/O failed: {0}")]
    Io(#[from] io::Error),

    #[error("journal is not valid JSON: {0}")]
    Json(#[from] serde_json::Error),

    #[error("unsupported journal version {0}")]
    UnsupportedVersion(u8),

    #[error("invalid journal: {0}")]
    Invalid(String),
}

#[derive(Clone, Debug)]
pub struct JournalStore {
    directory: PathBuf,
}

impl JournalStore {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
        }
    }

    pub fn load(&self, transfer_id: &str) -> Result<Option<TransferJournal>, JournalError> {
        let path = self.path_for(transfer_id)?;
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let journal: TransferJournal = serde_json::from_slice(&bytes)?;
        journal.validate()?;
        if journal.transfer_id != transfer_id {
            return Err(JournalError::Invalid(
                "transfer ID does not match file name".to_string(),
            ));
        }
        Ok(Some(journal))
    }

    /// Writes and fsyncs a temporary file before atomically replacing the
    /// visible journal. A crash can therefore lose only the latest progress
    /// update, never leave partially written JSON that discards the transfer.
    pub fn save(&self, journal: &TransferJournal) -> Result<(), JournalError> {
        journal.validate()?;
        fs::create_dir_all(&self.directory)?;
        let destination = self.path_for(&journal.transfer_id)?;
        let temporary = self.directory.join(format!(
            ".{}.{}.tmp",
            journal.transfer_id,
            uuid::Uuid::new_v4()
        ));
        let bytes = serde_json::to_vec(journal)?;

        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        let result = (|| -> Result<(), JournalError> {
            file.write_all(&bytes)?;
            file.sync_all()?;
            fs::rename(&temporary, &destination)?;
            sync_directory(&self.directory)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    pub fn delete(&self, transfer_id: &str) -> Result<(), JournalError> {
        let path = self.path_for(transfer_id)?;
        match fs::remove_file(path) {
            Ok(()) => sync_directory(&self.directory).map_err(Into::into),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    fn path_for(&self, transfer_id: &str) -> Result<PathBuf, JournalError> {
        if transfer_id.is_empty()
            || transfer_id.contains('/')
            || transfer_id.contains('\\')
            || transfer_id == "."
            || transfer_id == ".."
        {
            return Err(JournalError::Invalid("unsafe transfer ID".to_string()));
        }
        Ok(self.directory.join(format!("{transfer_id}.json")))
    }
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> io::Result<()> {
    std::fs::File::open(path)?.sync_all()
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory() -> PathBuf {
        std::env::temp_dir().join(format!("flashdrop-journal-{}", uuid::Uuid::new_v4()))
    }

    fn journal() -> TransferJournal {
        let mut value = TransferJournal::new(
            "transfer-1".to_string(),
            "ABCDEF012345".to_string(),
            TransferDirection::Send,
            42,
        );
        value.files.insert(
            "video-1".to_string(),
            ResumableFile {
                name: "video.mp4".to_string(),
                size: 3_000_000_000,
                committed_bytes: 1_500_000_000,
                sha256: Some("abc".to_string()),
                status: ResumeFileStatus::Paused,
            },
        );
        value
    }

    #[test]
    fn persists_and_loads_a_large_file_offset() {
        let directory = test_directory();
        let store = JournalStore::new(&directory);
        let expected = journal();
        store.save(&expected).unwrap();
        assert_eq!(store.load("transfer-1").unwrap(), Some(expected));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_an_offset_larger_than_the_file() {
        let mut value = journal();
        value.files.get_mut("video-1").unwrap().committed_bytes = 3_000_000_001;
        assert!(matches!(value.validate(), Err(JournalError::Invalid(_))));
    }

    #[test]
    fn rejects_path_traversal_in_transfer_ids() {
        let store = JournalStore::new(test_directory());
        assert!(matches!(
            store.load("../secret"),
            Err(JournalError::Invalid(_))
        ));
    }

    #[test]
    fn corrupted_journal_is_reported_instead_of_silently_discarded() {
        let directory = test_directory();
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("transfer-1.json"), b"{broken").unwrap();
        let store = JournalStore::new(&directory);
        assert!(matches!(
            store.load("transfer-1"),
            Err(JournalError::Json(_))
        ));
        fs::remove_dir_all(directory).unwrap();
    }
}
