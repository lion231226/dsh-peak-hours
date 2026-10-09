// Verifier-owned: strip HTML from verify/raw/*.html into verify/raw/*.txt (no deps).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const raw = join(dirname(fileURLToPath(import.meta.url)), 'raw')
const dec = (buf) => {
  const head = buf.subarray(0, 4096).toString('latin1').toLowerCase()
  let cs = 'utf8'
  const m = /charset=["']?([\w-]+)/.exec(head)
  if (m) cs = m[1]
  try { return new TextDecoder(cs).decode(buf) } catch { return buf.toString('utf8') }
}
const strip = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)[^>]*>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/[ \t\u3000]+/g, ' ')
  .replace(/\n{2,}/g, '\n')
  .trim()

for (const f of readdirSync(raw).filter((x) => x.endsWith('.html'))) {
  const txt = strip(dec(readFileSync(join(raw, f))))
  writeFileSync(join(raw, f.replace(/\.html$/, '.txt')), txt, 'utf8')
  console.log(`${f} -> ${f.replace(/\.html$/, '.txt')} (${txt.length} chars)`)
}
