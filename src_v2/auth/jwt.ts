const b64u = {
  enc(bytes: Uint8Array) {
    let bin = ""; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  },
  dec(b64u: string) {
    let b64 = b64u.replace(/-/g,"+").replace(/_/g,"/"); while (b64.length % 4) b64 += "=";
    const bin = atob(b64); const out = new Uint8Array(bin.length);
    for (let i=0;i<bin.length;i++) out[i]=bin.charCodeAt(i);
    return out;
  }
};
async function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign","verify"]);
}
export async function signJWT(payload: any, secret: string) {
  const header = { alg: "HS256", typ: "JWT" };
  const enc = new TextEncoder();
  const h = b64u.enc(enc.encode(JSON.stringify(header)));
  const p = b64u.enc(enc.encode(JSON.stringify(payload)));
  const data = `${h}.${p}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return `${data}.${b64u.enc(new Uint8Array(sig))}`;
}
export async function verifyJWT(token: string, secret: string) {
  if (!token) return { ok: false as const, error: "missing" };
  const parts = token.split("."); if (parts.length !== 3) return { ok:false as const, error:"format" };
  const [h,p,s] = parts; const data = `${h}.${p}`;
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify("HMAC", key, b64u.dec(s), new TextEncoder().encode(data));
  if (!ok) return { ok:false as const, error:"signature" };
  const payload = JSON.parse(new TextDecoder().decode(b64u.dec(p)));
  if (payload?.exp && Date.now()/1000 >= payload.exp) return { ok:false as const, error:"expired" };
  return { ok:true as const, payload };
}
