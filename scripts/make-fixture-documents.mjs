#!/usr/bin/env node
/**
 * Generates the binary resume fixtures used by the E2E tests.
 *
 * Both files are written by hand rather than checked in as opaque binaries, so
 * what the tests feed the parsers is always visible in review. Everything runs
 * on node's built-in zlib.
 */
import { deflateRawSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'resumes');
mkdirSync(outDir, { recursive: true });

/* ------------------------------------------------------------------ */
/* DOCX (a ZIP archive containing word/document.xml)                    */
/* ------------------------------------------------------------------ */

const DOC_LINES = [
  'Grace Hopper',
  'grace.hopper@example.com',
  '+1 202 555 0143',
  'https://linkedin.com/in/gracehopper',
  'https://github.com/gracehopper',
  'https://grace.example.com',
  'EXPERIENCE',
  'Compiler Engineer at Navy Electronics | Jan 1952 - Dec 1959',
  'Designed the first compiler for the COBOL language and led the team that shipped it on schedule.',
  'EDUCATION',
  'Yale University',
  'BSc',
  'Physics',
  'SKILLS',
  'COBOL, Fortran, Python, React, PostgreSQL, Docker',
  'PROJECTS',
  'Hopper Compiler',
  'A compiler that turned English-like statements into machine code.',
  'ACHIEVEMENTS',
  'Winner - National Engineering Hackathon 2019',
];

const xmlEscape = (value) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const documentXml =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
  DOC_LINES.map((line) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`).join('') +
  '</w:body></w:document>';

const contentTypes =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>';

const rootRels =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

/** CRC-32, as required by the ZIP format. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, content } of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const raw = Buffer.from(content, 'utf8');
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBytes, data);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0x21, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, centralBuffer, eocd]);
}

const docx = zip([
  { name: '[Content_Types].xml', content: contentTypes },
  { name: '_rels/.rels', content: rootRels },
  { name: 'word/document.xml', content: documentXml },
]);
writeFileSync(path.join(outDir, 'resume.docx'), docx);

/* ------------------------------------------------------------------ */
/* PDF (uncompressed content stream, the shape a text extractor meets)  */
/* ------------------------------------------------------------------ */

const PDF_LINES = [
  'Alan Turing',
  'alan.turing@example.com',
  '+44 20 7946 0000',
  'https://linkedin.com/in/alanturing',
  'https://github.com/alanturing',
  'EXPERIENCE',
  'Research Fellow at Bletchley Park | 1939 - 1945',
  'Designed the bombe machine and laid the foundations for stored-program computing.',
  'EDUCATION',
  'University of Cambridge',
  'BSc',
  'Mathematics',
  'SKILLS',
  'COBOL, Python, TypeScript, React, PostgreSQL, AWS',
  'PROJECTS',
  'Bombe',
  'An electromechanical machine used to break German ciphers during the war.',
];

/** One text-showing operator per line, which is what the extractor reads. */
const content =
  'BT /F1 11 Tf 14 TL 60 760 Td\n' +
  PDF_LINES.map((line) => `(${line.replace(/([()\\])/g, '\\$1')}) Tj T*\n`).join('') +
  'ET';

const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  null, // the content stream, written separately
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
];

let pdf = '%PDF-1.4\n';
const offsets = [];
objects.forEach((object, index) => {
  offsets.push(pdf.length);
  if (object === null) {
    pdf += `${index + 1} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`;
  } else {
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
});

const xrefStart = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

writeFileSync(path.join(outDir, 'resume.pdf'), Buffer.from(pdf, 'latin1'));

console.log(`wrote ${path.relative(process.cwd(), outDir)}/resume.docx (${docx.length} bytes)`);
console.log(`wrote ${path.relative(process.cwd(), outDir)}/resume.pdf (${pdf.length} bytes)`);
