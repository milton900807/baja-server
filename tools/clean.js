// Remove the build output (dist) but PRESERVE downloaded reference data so a
// rebuild never wipes the large, runtime-downloaded Ensembl/GENCODE files.
const fs = require('fs');
const path = require('path');

const dist = path.resolve(__dirname, '..', 'dist');
const preserve = new Set(['reference_data']);

if (fs.existsSync(dist)) {
    for (const entry of fs.readdirSync(dist)) {
        if (preserve.has(entry)) continue;
        fs.rmSync(path.join(dist, entry), { recursive: true, force: true });
    }
}
