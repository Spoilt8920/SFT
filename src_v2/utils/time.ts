export const unixNow = () => Math.floor(Date.now() / 1000);
export const minuteBucket = (ms = Date.now()) => Math.floor(ms / 60000);
export const dayTs = (tsSec?: number) => {
  const s = typeof tsSec === "number" ? tsSec : Math.floor(Date.now() / 1000);
  return s - (s % 86400);
};
export const daysAgoMidnightTs = (n: number) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return Math.floor(d.getTime() / 1000);
};
