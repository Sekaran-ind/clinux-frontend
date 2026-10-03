// A photo picked in a journey's form (`type: 'image'` fields) -> { name, value: base64, type, size }.
// Phone cameras often produce photos over registries' limits (HFR: 5 MB), so anything larger than
// `shrinkAbove` is redrawn as a JPEG no wider or taller than `maxSide` pixels before it is kept.
const readAsDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(new Error('The file could not be read.'));
  r.readAsDataURL(blob);
});

async function shrink(file, maxSide, quality) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

export async function readImage(file, { shrinkAbove = 2 * 1024 * 1024, maxSide = 1600, quality = 0.85 } = {}) {
  if (!/^image\/(png|jpe?g)$/.test(file.type)) throw new Error('Choose a PNG or JPEG image.');
  let blob = file;
  let name = file.name;
  if (file.size > shrinkAbove) {
    blob = (await shrink(file, maxSide, quality)) || file;
    if (blob !== file) name = name.replace(/\.\w+$/, '') + '.jpg';
  }
  const dataUrl = await readAsDataUrl(blob);
  return { name, value: dataUrl.slice(dataUrl.indexOf(',') + 1), type: blob.type || file.type, size: blob.size };
}

// A document picked in a journey's form (`type: 'file'` fields): a certificate or proof as PDF, PNG
// or JPEG, kept as-is up to `maxBytes` (NHA's HPR limit is 5 MB, HPR-060/075). Large photos are
// shrunk like readImage's; a PDF over the limit is refused.
export const DOCUMENT_TYPES = /^(application\/pdf|image\/(png|jpe?g))$/;
export async function readDocument(file, { maxBytes = 5 * 1024 * 1024 } = {}) {
  if (!DOCUMENT_TYPES.test(file.type)) throw new Error('Choose a PDF, PNG or JPEG file.');
  if (file.type.startsWith('image/')) {
    const img = await readImage(file, { shrinkAbove: maxBytes });
    if (img.size > maxBytes) throw new Error('The file is larger than 5 MB.');
    return img;
  }
  if (file.size > maxBytes) throw new Error('The file is larger than 5 MB.');
  const dataUrl = await readAsDataUrl(file);
  return { name: file.name, value: dataUrl.slice(dataUrl.indexOf(',') + 1), type: file.type, size: file.size };
}
