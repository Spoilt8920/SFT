export const json = (data: any, init: ResponseInit = {}) => {
  const h = new Headers(init.headers || {});
  if (!h.has("content-type")) h.set("content-type","application/json");
  return new Response(JSON.stringify(data), { ...init, headers: h });
};
export const unixNow = () => Math.floor(Date.now()/1000);
