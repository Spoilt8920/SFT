const b64u = {
  enc(bytes: Uint8Array) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(s: string) {
    let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

async function deriveAesKey(passphrase: string, salt: Uint8Array) {
  const mat = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  // NOTE: TS sometimes widens Uint8Array to Uint8Array<ArrayBufferLike> under some libs.
  // Coerce to BufferSource to satisfy subtle.deriveKey overload.
  const saltBs = (salt as unknown) as BufferSource;

  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBs, iterations: 100_000, hash: "SHA-256" },
    mat,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Encrypts -> base64url(salt[16] + iv[12] + ct[...]) */
export async function encryptString(plain: string, passphrase: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  const ctBytes = new Uint8Array(ct);

  const packed = new Uint8Array(salt.length + iv.length + ctBytes.length);
  packed.set(salt, 0);
  packed.set(iv, salt.length);
  packed.set(ctBytes, salt.length + iv.length);

  return b64u.enc(packed);
}

export async function decryptString(packedB64Url: string, passphrase: string) {
  const packed = b64u.dec(packedB64Url);
  const salt = packed.slice(0, 16);
  const iv = packed.slice(16, 28);
  const ct = packed.slice(28);

  const key = await deriveAesKey(passphrase, salt);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}
