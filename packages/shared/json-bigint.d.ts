declare module 'json-bigint' {
  export default function JSONbig(options: { alwaysParseAsBig?: boolean }): { parse(text: string): any; stringify(value: unknown): string }
}
