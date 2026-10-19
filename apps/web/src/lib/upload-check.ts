// Checks of the archive in the browser, before the upload: a file over the limit is refused by the server only after
// all its bytes have gone over the wire, and a proxy in front may answer 413 with a page instead of a message.

/** a problem with the chosen file, in words for the author; null when it can be sent */
export function archiveProblem(file: { name: string; size: number }, maxBytes: number): string | null {
  if (file.size === 0) return "Файл пустой.";
  if (file.size > maxBytes) {
    const mb = (file.size / 1024 / 1024).toFixed(1).replace(/\.0$/, "");
    return `Архив ${mb} МБ, а можно до ${Math.round(maxBytes / 1024 / 1024)} МБ. Убери из папки лишнее и заархивируй снова.`;
  }
  if (!/\.zip$/i.test(file.name)) return "Нужен файл .zip: заархивируй папку сценария.";
  return null;
}
