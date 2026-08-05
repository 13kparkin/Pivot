const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}

const issued = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (typeof issued.credential !== "string" || issued.credential.length === 0) {
  throw new Error("Pairing output did not include a credential.");
}

const publicUrl = process.env.T3CODE_PUBLIC_URL?.trim();
if (!publicUrl) {
  throw new Error("T3CODE_PUBLIC_URL is required.");
}

const hostedAppUrl = process.env.T3CODE_HOSTED_APP_URL?.trim() || "https://app.t3.codes";
const environmentLabel = process.env.T3CODE_ENVIRONMENT_LABEL?.trim() || "Render cloud agent";
const pairUrl = new URL("/pair", hostedAppUrl);
pairUrl.searchParams.set("host", new URL(publicUrl).origin);
pairUrl.searchParams.set("label", environmentLabel);
pairUrl.hash = new URLSearchParams([["token", issued.credential]]).toString();

process.stdout.write(`Pair URL: ${pairUrl.toString()}\n`);
