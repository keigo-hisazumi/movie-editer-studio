/** movie-editer-schema の EditDoc として正しいか（保存する前に確かめる。movie-editer と同じ schema.json） */
import validateEditDoc from 'virtual:editdoc-validator';

/** 形が違う所（無ければ空）。場所は EditDoc.captions[0].text のように書く */
export function validate(doc: unknown): string[] {
  if (validateEditDoc(doc)) return [];
  return (validateEditDoc.errors ?? []).map((e) => {
    const where = e.instancePath
      .split('/')
      .slice(1)
      .map((p) => (/^\d+$/.test(p) ? `[${p}]` : `.${p}`))
      .join('');
    return `EditDoc${where}: ${e.message ?? ''}`;
  });
}
