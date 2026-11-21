/** vite.config.ts の editDocValidator が作る、EditDoc を検査する関数（Ajv の standalone） */
declare module 'virtual:editdoc-validator' {
  interface ValidateFn {
    (data: unknown): boolean;
    errors?: { instancePath: string; message?: string }[] | null;
  }
  const validate: ValidateFn;
  export default validate;
}
