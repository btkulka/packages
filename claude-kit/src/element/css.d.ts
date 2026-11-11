// esbuild's text loader: a stylesheet imported as its text.
declare module "*.css" {
  const text: string;
  export default text;
}
