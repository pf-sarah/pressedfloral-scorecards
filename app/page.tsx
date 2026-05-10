import fs from "node:fs";
import path from "node:path";
import Script from "next/script";

const legacyMarkup = fs.readFileSync(
  path.join(process.cwd(), "legacy/markup.html"),
  "utf8"
);

export default function Home() {
  return (
    <>
      <div
        id="legacy-root"
        dangerouslySetInnerHTML={{ __html: legacyMarkup }}
      />
      <Script src="/legacy.js" strategy="afterInteractive" />
    </>
  );
}
