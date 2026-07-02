import "dotenv/config";
import { fetch, ProxyAgent } from "undici";

const proxyUrl = process.env.CHARLES_PROXY || "http://10.10.10.103:8888";

console.log("proxy =", proxyUrl);

const dispatcher = new ProxyAgent(proxyUrl);

async function main() {
    const res = await fetch("https://api.deepseek.com", {
        dispatcher,
    } as any);

    console.log("status =", res.status);
    console.log(await res.text());
}

main().catch(console.error);