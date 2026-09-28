/// <reference lib="webworker" />

import sodium from "libsodium-wrappers";

type EncryptRequest = { id: number; key: ArrayBuffer; plain: ArrayBuffer };

self.onmessage = async (event: MessageEvent<EncryptRequest>) => {
  const { id, key, plain } = event.data;
  try {
    await sodium.ready;
    const iv = sodium.randombytes_buf(sodium.crypto_aead_chacha20poly1305_ietf_NPUBBYTES);
    const cipher = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
      new Uint8Array(plain),
      null,
      null,
      iv,
      new Uint8Array(key),
      "uint8array",
    );
    const cipherBuffer = cipher.buffer as ArrayBuffer;
    self.postMessage({ id, ivHex: sodium.to_hex(iv), cipher: cipherBuffer }, { transfer: [cipherBuffer] });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : "Encryption failed" });
  }
};

export {};
