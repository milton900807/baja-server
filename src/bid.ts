const fs = require('fs');
const path = require('path');
// const BigWig = require('node-bigwig');
const DATA_DIR = path.join(__dirname, 'data');
async function getBigWigData(filePath: any, chrom: any, start: number, end: number) {
    return new Promise((resolve, reject) => {
        // BigWig.read(filePath, { chrom, start, end }, (err: any, data: unknown) => {
        //     if (err) reject(err);
        //     resolve(data);
        // });
        resolve ({})
    });
}
export class DataIndex {
    updateAPI(app: any) {
        app.get('/get', async (req: { query: { file: any}; },
            res: { status: (arg0: number) => { (): any; new(): any; send: { (arg0: string): void; new(): any; }; }; json: (arg0: { [x: number]: unknown; }) => void; }) => {
            const { file } = req.query;
            if (!file ) {
                return res.status(400).send('Missing required query parameters');
            }
            const filePath = path.join(DATA_DIR, file);
            if (!fs.existsSync(filePath)) {
                return res.status(404).send('File not found');
            }
            try {
                res.json ({});
            } catch (err) {
                res.status(500).send('Error reading data');
            }
        });
        app.get('/genomic-region', async (req: { query: { file: any; chrom: any; start: any; end: any; }; },
            res: { status: (arg0: number) => { (): any; new(): any; send: { (arg0: string): void; new(): any; }; }; json: (arg0: { [x: number]: unknown; }) => void; }) => {
            const { file, chrom, start, end } = req.query;
            if (!file || !chrom || !start || !end) {
                return res.status(400).send('Missing required query parameters');
            }
            const filePath = path.join(DATA_DIR, file);
            if (!fs.existsSync(filePath)) {
                return res.status(404).send('File not found');
            }
            try {
                // const data = await getBigWigData(filePath, chrom, parseInt(start), parseInt(end));
                // res.json({ [file]: data });
                res.json ({});
            } catch (err) {
                res.status(500).send('Error reading BigWig data');
            }
        });
        app.get('/list', (req: any, res: { status: (arg0: number) => { (): any; new(): any; send: { (arg0: string): any; new(): any; }; }; json: (arg0: any) => void; }) => {
            fs.readdir(DATA_DIR, (err: any, files: any) => {
                if (err) {
                    return res.status(500).send('Error reading data directory');
                }
                res.json(files);
            });
        });

    }
}

