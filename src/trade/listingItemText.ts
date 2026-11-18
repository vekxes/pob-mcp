// Match the item text limit in lua/pob_ops.lua before returning a comparison input.
const MAX_ITEM_TEXT_BYTES = 10_240;
const MAX_BASE64_LENGTH = Math.ceil(MAX_ITEM_TEXT_BYTES / 3) * 4;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const clipboardHeader = /^(?:Item Class: [^\n]+\n)?Rarity: (Normal|Magic|Rare|Unique|Relic)\n/i;

/** Decode the official PoE 1 trade result's Base64 clipboard export. */
export function decodeListingItemText(encoded: unknown): string | undefined {
  if (typeof encoded !== 'string' || encoded.length > MAX_BASE64_LENGTH || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_ITEM_TEXT_BYTES || bytes.toString('base64') !== encoded) return;

  let text: string;
  try {
    text = utf8.decode(bytes).replace(/\r\n?/g, '\n').trimEnd();
  } catch {
    return;
  }
  // GGG appends listing notes as their own final clipboard section.
  text = text.replace(/\n--------\nNote:[^\n]*$/, '');
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text) || /^[\t ]*(?:Unidentified[\t ]*$|Note:)/mi.test(text)) return;

  const header = clipboardHeader.exec(text);
  if (!header) return;
  const divider = text.indexOf('\n--------\n', header[0].length);
  if (divider === -1) return;
  const names = text.slice(header[0].length, divider).split('\n');
  const expectedNames = /^(normal|magic)$/i.test(header[1]) ? 1 : 2;
  if (names.length !== expectedNames || names.some(line => !line.trim() || line === '--------')) return;
  return text;
}
