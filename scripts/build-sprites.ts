// build-sprites.ts - Compile individual images into sprite sheet with JSON atlas

import * as fs from 'fs';
import * as path from 'path';
import { packAsync } from 'free-tex-packer-core';

const SOURCE_DIR = 'public/assets/sprites/items';
const OUTPUT_DIR = 'public/assets/sprites';

async function main() {
  console.log('Building sprite sheet...\n');

  // Ensure output directory exists
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Read all PNG files from source directory
  console.log('Loading source images...');
  const images: { path: string; contents: Buffer }[] = [];

  const files = fs.readdirSync(SOURCE_DIR).filter(f => f.endsWith('.png'));

  for (const file of files) {
    const sourcePath = path.join(SOURCE_DIR, file);
    console.log(`  ${file}`);
    images.push({
      path: file,
      contents: fs.readFileSync(sourcePath),
    });
  }

  if (images.length === 0) {
    console.error('No images found. Exiting.');
    process.exit(1);
  }

  console.log(`\nPacking ${images.length} sprites into sheet...`);

  // Pack sprites into sheet
  const packResult = await packAsync(images, {
    textureName: 'items',
    width: 1024,
    height: 1024,
    fixedSize: false,
    powerOfTwo: true,
    padding: 1,
    allowRotation: false,
    allowTrim: false,
    exporter: 'JsonHash',
    removeFileExtension: true,
  });

  // Write output files
  for (const file of packResult) {
    const outputPath = path.join(OUTPUT_DIR, file.name);
    fs.writeFileSync(outputPath, file.buffer);
    console.log(`  Written: ${outputPath}`);
  }

  console.log('\nSprite sheet build complete!');
}

main().catch((error) => {
  console.error('Build failed:', error);
  process.exit(1);
});
