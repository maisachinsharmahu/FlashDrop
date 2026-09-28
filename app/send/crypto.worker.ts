/// <reference lib="webworker" />

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { bytesToHex, randomBytes } from "@noble/ciphers/utils.js";

type EncryptRequest = { id: number; key: ArrayBuffer; plain: ArrayBuffer };

self.onmessage = (event: MessageEvent<EncryptRequest>) => {
  const { id, key, plain } = event.data;
  try {
    const iv = randomBytes(12);
    const cipher = chacha20poly1305(new Uint8Array(key), iv).encrypt(new Uint8Array(plain));
    const cipherBuffer = cipher.buffer as ArrayBuffer;
    self.postMessage({ id, ivHex: bytesToHex(iv), cipher: cipherBuffer }, { transfer: [cipherBuffer] });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : "Encryption failed" });
  }
};

export {};
