import { json } from 'body-parser'
import { Client } from 'pg'
import { Readable } from 'stream'
const settings = { 'docusignService': 'http://localhost:5000' }
const dbconfig = {
    host: 'eln-db.postgres.database.azure.com',
    user: 'arctadmin@eln-db',
    password: 'sp3arGunner!!',
    database: 'lipids',
    port: 5432,
    ssl: true
}
const prefix = '/py-compute'
const excel = require('excel4node');
const tempfile = require('tempfile');
const XLSX = require('xlsx')
const Excel = require("exceljs");

export class PyCompute {
    updateAPI(app: any) {
        app.post(`${prefix}/save-formulations-comment`, async (req: { body: { formulation_id: string, pka_calculated: number, pka_measured: number, logP: number, epo: number, comment: string }; }, res: { json: (arg0: { rowCount?: any; }) => void; }) => {
            const db_client = new Client(dbconfig)
            db_client.connect(
                async err => {
                    if (err) {
                        console.log(JSON.stringify(err))
                        throw err;
                    }
                    else {
                        // const l = db_client.query ( `select atx.studies where id = ${lipid}`)
                        // const sql = `UPDATE exp.doctrac SET folder_id = '${folderid}' WHERE id = ${dxpid}`
                        // // const sql = `UPDATE exp.doctrac SET folder_id = '${folderid}', doc_id = '${doc_id}' WHERE id = ${dxpid}`
                        // db_client.query(sql, (err: any, _res: { rowCount?: any; }) => {
                        //     if (err !== undefined && err != null) {
                        //         console.log("Postgres INSERT error:", err);
                        //         console.log("Postgres error position:", err);
                        //     }
                        //     if (_res !== undefined) {
                        //         console.log(" done. ")
                        //         res.json(_res)
                        //     }
                        // });
                    }
                }
            )
        })
        app.get(`${prefix}/dose-response`, async (req: [{ name: string, order: string, is_standard: string, notes: string, dose: [], response: [] }]
            , res: { json: ({ }) => void; }) => {
            const samples = req;
            const PythonShell = require('python-shell').PythonShell;
            // Create a new instance of a Workbook class
            const workbook = new excel.Workbook();
            const worksheet = workbook.addWorksheet('dose');
            const worksheet2 = workbook.addWorksheet('response');
            const template_id = workbook.addWorksheet('template_identifier')
            template_id.cell(1, 1).string("eccpy|xlsx|generic|vertical")
            const style = workbook.createStyle({
                font: {
                    color: '#FF0800',
                    size: 12,
                },
                numberFormat: '$#,##0.00; ($#,##0.00); -',
            });
            for (const sample of samples) {
                worksheet.cell(1, 1).string(sample.name)
                let index = 2;
                for (const d of sample.dose) {
                    // console.log('\t\t' + d);
                    worksheet.cell(index++, 1).number(d);// .style(style)
                }
                const cell = worksheet2.cell(1, 1);
                cell.string(sample.name);
                index = 2;
                for (const r of sample.response) {
                    // console.log('\t\t' + r);
                    worksheet2.cell(index++, 1).number(r);// style(style);
                }
            }
            // let tfile = tempfile('.xlsx');
            const filename = 'data-file-temp.xlsx'
            const tfile = `data/${filename}`
            await workbook.write(tfile);

            const file = '/workspaces/arcturing-server/py-scripts/template.xlsx'


            await createExcelFiles(file, filename, 'data', 'results/lipid-data', samples);
            const options = {
                // mode: 'text',
                // pythonPath: '/usr/bin/python',
                // pythonOptions: ['-u'],
                // make sure you use an absolute path for scriptPath
                // scriptPath: '/home/username/Test_Project/Python_Script_dir',
                args: [`settings.xlsx`, "./output.xlsx"]
            };
            const pydata = await (() => {
                return new Promise(async (resolve, reject) => {
                    PythonShell.run('./py-scripts/stats/dose-response.py', options, (err: any, results: any) => {

                        console.log(" done -=---- - -- " + tfile)
                        if (err) {
                            resolve(err);
                        } else {
                            console.log('finished');
                            console.log(results)
                            resolve(results)
                        }
                    });
                })
            })();
            return res.json({
                'res': pydata
            })
        })

        app.get(`${prefix}/test`, async (req: any, res: { json: ({ }) => void; }) => {
            console.log(" ----------------------- ")
            return res.json({
                'hello': 'world'
            })
        })



        async function createExcelFiles(file: string, response_data_file: string, input_file_directory: string,
            output_file_directory: string, samples: any[]): Promise<any> {
            return new Promise(async (resolve, reject) => {
                let sourceWorkbook = new Excel.Workbook();
                sourceWorkbook = await sourceWorkbook.xlsx.readFile(file);
                const sourceWorksheet = sourceWorkbook.getWorksheet('settings'); // you can add new sheet as well.
                const targetWorkbook = new Excel.Workbook();
                const targetWorksheet = targetWorkbook.addWorksheet('settings'); // you can add new sheet as well.
                const dataWorksheet = targetWorkbook.addWorksheet('files'); // you can add new sheet as well.
                const samplesNamesWorksheet = targetWorkbook.addWorksheet('samplenames'); // you can add new sheet as well.
                samplesNamesWorksheet.addRow([
                    "long name", "short name", "order in figure", "standard for normalisation?", "notes"
                ])
                for (const sample of samples) {
                    samplesNamesWorksheet.addRow([sample.name, sample.name, sample.order, sample.is_standard, sample.comment
                    ])
                }

                // long name	short name	order in figure	standard for normalisation?	notes
                // control	control	1	TRUE	Normalise each day to this sample
                // sample1	s1	2
                // sample2	s2	3
                // sample3	s3	4
                // sample4	s4	5



                dataWorksheet.addRow(["run curvefit", "run gatherer", "notes & comments", "response data file", "dose conc file", "response dataformat", "input file directory",
                    "output file directory"])
                dataWorksheet.addRow(["TRUE", "TRUE", "", `${response_data_file}`, "None", "eccpy|xlsx|generic|vertical",
                    `${input_file_directory}`,
                    `${output_file_directory}`])
                // await targetWorkbook.xlsx.writeFile('target.xlsx');
                // let sourceWorkbook = new Excel.Workbook();
                // sourceWorkbook = await sourceWorkbook.xlsx.readFile(tfile);
                // const sourceWorksheet = sourceWorkbook.getWorksheet('settings');
                // copySheet.model = Object.assign(ws1.model, {
                //     mergeCells: sheet2.model.merges
                // });
                sourceWorksheet.eachRow({ includeEmpty: false }, (row: {
                    eachCell: (arg0: { includeEmpty: boolean }, arg1: (cell: any, cellNumber: any) =>
                        void) => void; commit: () => void
                }, rowNumber: any) => {
                    const targetRow = targetWorksheet.getRow(rowNumber);
                    row.eachCell({ includeEmpty: false }, (cell, cellNumber) => {
                        targetRow.getCell(cellNumber).value = cell.value;
                    });
                    console.log(' ---- ')
                    row.commit();
                });
                await targetWorkbook.xlsx.writeFile('settings.xlsx');
                resolve(targetWorkbook)
            });
        }

        // copyExcel();

    }



}