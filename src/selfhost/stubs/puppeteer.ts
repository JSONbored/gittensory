// Self-host stub for @cloudflare/puppeteer (Browser Rendering is a Cloudflare-only binding). The only caller,
// review/visual/shot.ts, does `if (!env.BROWSER) return {...}` BEFORE puppeteer.launch — and BROWSER is absent
// on self-host — so launch is never reached. This stub just makes the import resolve (no cloudflare:* imports).
const unavailable = (): never => {
  throw new Error("Browser Rendering (@cloudflare/puppeteer) is unavailable on the self-host runtime");
};

export default { launch: unavailable, connect: unavailable };
