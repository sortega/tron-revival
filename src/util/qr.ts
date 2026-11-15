import qrcode from 'qrcode-generator';

/** QR code of `text` as a scalable SVG tag ('' if it cannot be encoded). */
export function qrSvg(text: string): string {
  try {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  } catch {
    return '';
  }
}
