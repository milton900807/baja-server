import { Client } from 'pg'


// const settings = { 'docusignService': 'http://localhost:5000' }
const dbconfig = {
    host: 'eln-db.postgres.database.azure.com',
    user: 'aradmin@eln-db',
    password: '!!',
    database: 'test',
    port: 5432,
    ssl: true
}

export class ELNDocTracker {

    updateAPI(app: any) {
        app.get('/eln/test-doctrac', (req: any, res: any) => {
            return res.json({ 'status': '--test-' });
        });




        app.get('/eln/get-status', async (req: any, __res: any) => {
            const dxpid = '' + req.query.id;
            let signer = '' + req.query.signer;
            const db_client = new Client(dbconfig)
            if (signer.endsWith('"')) {
                signer = signer.substring(1, signer.length - 1)
            }
            db_client.connect(
                async err => {
                    if (err) {
                        console.log(JSON.stringify(err))
                        throw err;
                    }
                    else {
                        try {
                            const sql = `select signed -> 'signers' -> '${signer}' from exp.elndoctrac where id = '${dxpid}'`
                            db_client.query(sql, (err, results: { rowCount?: any; rows: any }) => {
                                if (err !== undefined && err != null) {
                                    console.log("Postgres INSERT error:", err);
                                    console.log("Postgres error position:", err);
                                }
                                if (results !== undefined) {
                                    if (results.rowCount > 0) {
                                        return __res.json(results.rows[0]['?column?']);
                                    } else {
                                        return __res.json({ 'status': 'None', 'msg': 'No documents for user ' + signer, 'rows': [] });
                                    }
                                }
                            });
                        } catch (exception) {
                            return __res.json(exception)
                        }
                    }
                }
            )
        });





        app.get('/eln/list-docs', (req: { query: { userid: string; doc_status: any; }; }, res: { json: (arg0: { status: string; msg: any; rows: any; }) => void; }) => {
            let userid = req.query.userid + '';
            userid = userid.toLocaleLowerCase();
            let doc_status = req.query.doc_status;
            if (doc_status == null || doc_status == undefined || doc_status.length <= 0)
                doc_status = 'active';
            const client = new Client(dbconfig)
            client.connect(
                err => {
                    if (err) {
                        console.log(JSON.stringify(err))
                        throw err;
                    }
                    else {
                        // queryDatabase();
                    }
                }
            )
            let queryString = `select id, doc_id, name, author, date_created, drive_id, folder_id, signed, group_name, doc_status from exp.elndoctrac where doc_status = 'active' order by doc_id desc limit 10000`;
            if (userid != null && userid.trim().length > 0 && userid != undefined && userid != 'undefined') {
                const ind = userid.indexOf('@');
                if (ind > 0) {
                    userid = userid.substring(0, ind);
                }
                queryString = `select id, doc_id, name, author, date_created, drive_id, folder_id, signed, group_name, doc_status from exp.elndoctrac where author = '` + userid + `' and doc_status = '${doc_status}' order by date_created desc limit 10000`;
            }
            console.log(queryString)
            client.query(queryString, (err, _res: { rowCount?: any; rows: any }) => {
                if (err !== undefined && err != null) {
                    console.log("Postgres INSERT error:", err);
                    console.log("Postgres error position:", err);
                }
                if (_res !== undefined) {
                    if (_res.rowCount > 0) {
                        return res.json({ 'status': 'success', 'msg': _res.rowCount, 'rows': _res.rows });
                    } else {
                        return res.json({ 'status': 'None', 'msg': 'No documents for user ' + userid, 'rows': [] });
                    }
                }
            });
        });
        app.get('/eln/archive-doc', (req: { query: { userid: string; docid: string; }; }, res: { json: (arg0: { status: string; msg: string; }) => void; }) => {
            let userid = req.query.userid + '';
            const exp = '' + req.query.docid;
            const client = new Client(dbconfig)
            client.connect(
                err => {
                    if (err) {
                        console.log(JSON.stringify(err))
                        throw err;
                    }
                    else {
                        // queryDatabase();
                    }
                }
            )
            const ind = userid.indexOf('@');
            if (ind > 0) {
                userid = userid.substring(0, ind);
            }
            const docid = exp.split('DOC')[1]
            const queryString = `UPDATE exp.elndoctrac SET doc_status = 'archive' where author ='${userid}' and doc_id=${docid}`;
            console.log(queryString)
            client.query(queryString, (err, _res: { rowCount?: any; rows: any }) => {
                if (err !== undefined && err != null) {
                    console.log("Error :", err);
                }
                if (_res !== undefined) {
                    return res.json({ 'status': 'success', 'msg': 'Document ' + docid + ' has set to archive status ' });
                }
            });
        });
        function verify(key: number) {
            const date = new Date();
            const day = date.getDate();
            const month = date.getMonth() + 1;
            if ((900807 / day) + 1 > key && (900807 / day) - 1 < key)
                return true;
            else
                return false;
        }
        // app.get('/eln/delete-doc', async (req: { query: { expid: string; key: string | number; }; }, res: { json: (arg0: { msg?: string; rowCount?: any; }) => void; }) => {
        //     const client = new Client(dbconfig)
        //     const expid = '' + req.query.expid;
        //     const pwd = verify(+req.query.key);
        //     if (!pwd) {
        //         return res.json({
        //             'msg': 'Failed delete experiment; incorrect key value'

        //         });
        //     }
        //     console.log(' exepriment id ' + expid)
        //     client.connect(
        //         err => {
        //             if (err) {
        //                 console.log(JSON.stringify(err))
        //                 throw err;
        //             }
        //             else {
        //                 // queryDatabase();
        //             }
        //         }
        //     )
        //     // create a string object for Postgres SQL statement
        //     const queryString = `delete from exp.elndoctrac where id = ${expid}`
        //     console.log(" query string : " + queryString);
        //     client.query(queryString, (err, _res: { rowCount?: any; }) => {
        //         if (err !== undefined && err != null) {
        //             console.log("Postgres  error:", err);
        //             console.log("Postgres error position:", err);
        //         }
        //         if (_res !== undefined) {
        //             return res.json(_res);
        //         }

        //     });
        // })
        app.post('/eln/update-doctrac-folder-id', async (req: { body: { id: number; doc_id: string; folder_id: string; }; }, res: { json: (arg0: { rowCount?: any; }) => void; }) => {

            const doc_id = '' + req.body.doc_id;
            const dxpid = '' + req.body.id;
            const folderid = '' + req.body.folder_id;

            console.log('\n\n update-doc-folderid  doc id ' + dxpid + ' --' + folderid + ' --- ' + doc_id)
            const db_client = new Client(dbconfig)
            db_client.connect(
                async err => {
                    if (err) {
                        console.log(JSON.stringify(err))
                        throw err;
                    }
                    else {
                        const sql = `UPDATE exp.elndoctrac SET folder_id = '${folderid}' WHERE id = ${dxpid}`
                        // const sql = `UPDATE exp.elndoctrac SET folder_id = '${folderid}', doc_id = '${doc_id}' WHERE id = ${dxpid}`
                        db_client.query(sql, (err: any, _res: { rowCount?: any; }) => {
                            if (err !== undefined && err != null) {
                                console.log("Postgres INSERT error:", err);
                                console.log("Postgres error position:", err);
                            }
                            if (_res !== undefined) {
                                console.log(" done. ")
                                res.json(_res)
                            }

                        });
                    }
                }
            )
        })
        app.post('/eln/update-doctrac-sign', async (req: { body: { doc_id: string; signer: string; }; }, res: { json: (arg0: { rowCount?: any; }) => void; }) => {
            const dxpid = '' + req.body.doc_id;
            let signer = '' + req.body.signer;
            if (signer.endsWith('"'))
                signer = signer.substring(1, signer.length - 1)
            console.log(' doc id ' + dxpid + ' --' + signer)
            const db_client = new Client(dbconfig)
            db_client.connect(
                async err => {
                    if (err) {
                        console.log(JSON.stringify(err))
                        throw err;
                    }
                    else {
                        const sign_status = 'signed'
                        const sql = `update exp.elndoctrac set signed = jsonb_set (signed, '{"signer", "${signer}"}', '"${sign_status}"') where doc_id = ${dxpid}`
                        // const sql = `UPDATE exp.elndoctrac SET signed = '{"signer":"${signer}"}' WHERE folder_id = '${dxpid}'`
                        console.log(' sql : ' + sql)

                        db_client.query(sql, (err: any, _res: { rowCount?: any; }) => {
                            if (err !== undefined && err != null) {
                                console.log("Postgres INSERT error:", err);
                                console.log("Postgres error position:", err);
                            }
                            if (_res !== undefined) {
                                console.log(" done. ")
                                res.json(_res)
                            }

                        });
                    }
                }
            )
        })

        // do not think this is used.
        app.get('/eln/add-signer', async (req: any, res: { json: (arg0: { rowCount?: any; }) => void; }) => {
            const dxpid = '' + req.query.doc_id;
            const signer = '' + req.query.signer;
            const signerName = '' + req.query.signerName;
            console.log(' doc id ' + dxpid + ' --' + signer + ' --> ' + signerName)
            const db_client = new Client(dbconfig)
            db_client.connect(
                async err => {
                    if (err) {
                        console.log(JSON.stringify(err))
                        throw err;
                    }
                    else {
                        const sign_status = 'pending'
                        const sql = `update exp.elndoctrac set signed = jsonb_set (signed, '{"signers":{"${signer}":{"status":"${sign_status}","name":"${signerName}"') where id = '${dxpid}'`
                        // previous is this one below
                        // const sql = `update exp.elndoctrac set signed = jsonb_set (signed, '{"signers", "${signer}"}', '"${sign_status}"') where doc_id = ${dxpid}`
                        // const sql = `UPDATE exp.elndoctrac SET signed = '{"signer":"${signer}"}' WHERE folder_id = '${dxpid}'`
                        console.log(' sql : ' + sql)

                        db_client.query(sql, (err: any, _res: { rowCount?: any; }) => {
                            if (err !== undefined && err != null) {
                                console.log("Postgres INSERT error:", err);
                                console.log("Postgres error position:", err);
                            }
                            if (_res !== undefined) {
                                console.log(" done. ")
                                res.json(_res)
                            }

                        });
                    }
                }
            )
        })


        /**
         *  this assigns the envelope id to the user
         */
        app.get('/eln/set-envelopeId-for-sender', async (req: any, res: any) => {
            let envelopeId = '' + req.query.envelopeId;
            let sendToEmail = '' + req.query.sendToEmail;

            sendToEmail = sendToEmail.replace(/\"/g, '')
            envelopeId = envelopeId.replace(/\"/g, '')

            const dxpid = '' + req.query.documentId;
            const db_client = new Client(dbconfig)
            db_client.connect(
                async err => {
                    if (err) {
                        console.log(JSON.stringify(err))
                        throw err;
                    }
                    else {
                        const sql = `update exp.elndoctrac set signed = jsonb_set (signed, '{signers,${sendToEmail},envelopeId}', '"${envelopeId}"') where id = '${dxpid}'`
                        console.log(' sql : ' + sql)
                        await db_client.query(sql, (err: any, _res: { rowCount?: any; }) => {
                            if (err !== undefined && err != null) {
                                console.log("Postgres INSERT error:", err);
                                console.log("Postgres error position:", err);
                            }
                            if (_res !== undefined) {
                                console.log(" done. ")
                                res.json(_res)
                            } else
                                res.json({ 'msg': 'done' })

                        });
                    }
                }
            )

        })



        /**
         *  this assigns the envelope id to the user
         */
        app.get('/eln/set-signer-status', async (req: any, res: any) => {
            let id = '' + req.query.id;
            let signer = '' + req.query.signer;
            const signerName = '' + req.query.signerName;
            let status = '' + req.query.status;

            signer = signer.replace(/\"/g, '')
            status = status.replace(/\"/g, '')
            id = id.replace(/\"/g, '')

            const dxpid = '' + id;
            const db_client = new Client(dbconfig)
            db_client.connect(
                async err => {
                    let select_response: any = null;
                    if (err) {
                        console.log(JSON.stringify(err))
                        throw err;
                    }
                    else {
                        const sql1 = `SELECT signed from exp.elndoctrac where id = ${dxpid}`
                        select_response = await db_client.query(sql1);
                        if (select_response == null || select_response.rowCount == 0 || select_response.rows[0].signed == null) {
                            const sql_new_signer = `update exp.elndoctrac set signed = '{"signers":{"${signer}":{"status":"${status}","name":"${signerName}"}}}' where id = '${dxpid}'`;
                            console.log(" adding single signer : " + sql_new_signer);
                            const new_user_response = await db_client.query(sql_new_signer);
                            return res.json(new_user_response);
                        } else {

                            const row = select_response.rows[0];

                            if (select_response.rows[0].signed.signers[signer] == null) {
                                const sql1 = `update exp.elndoctrac set signed = jsonb_insert (signed, '{signers,${signer}}','{"status":"${status}"}') where id = ${dxpid}`
                                const update_unknown_signer = await db_client.query(sql1);
                                res.json(update_unknown_signer)
                            } else {
                                const sql = `update exp.elndoctrac set signed = jsonb_set (signed, '{signers,${signer},status}', '"${status}"') where id = '${dxpid}'`
                                console.log(' sql : ' + sql)
                                await db_client.query(sql, (err: any, _res: { rowCount?: any; }) => {
                                    if (err !== undefined && err != null) {
                                        console.log("Postgres INSERT error:", err);
                                        console.log("Postgres error position:", err);
                                    }
                                    if (_res !== undefined) {
                                        console.log(" done. ")
                                        res.json(_res)
                                    } else
                                        res.json({ 'msg': 'done' })
                                });
                            }
                        }
                    }
                }
            )
        })

        app.post('/eln/update-file-id-for-doctrac', async (req: { body: { trac_id: string; doc_id: string; }; }, res: { json: (arg0: { rowCount?: any; }) => void; }) => {
            const trac_id = '' + req.body.trac_id;
            const doc_id = '' + req.body.doc_id;
            console.log(" updating the track id :" + trac_id);
            const db_client = new Client(dbconfig)
            db_client.connect(
                async err => {
                    if (err) {
                        console.log(JSON.stringify(err))
                        throw err;
                    }
                    else {
                        const sql = `update exp.elndoctrac set doc_id = '${doc_id}' where id = ${trac_id}`
                        console.log(' sql : ' + sql)
                        db_client.query(sql, (err: any, _res: { rowCount?: any; }) => {
                            if (err !== undefined && err != null) {
                                console.log("Postgres INSERT error:", err);
                                console.log("Postgres error position:", err);
                            }
                            if (_res !== undefined) {
                                console.log(" done. ")
                                res.json(_res)
                            }

                        });
                    }
                }
            )
        })

        app.get('/eln/update-signer', async (req: any, res: { json: any }) => {
            let dxpid = '' + req.query.id;
            const author = '' + req.query.author;
            const group = 'eln'
            const drive_id = '-'
            const folder_id = '' + req.query.folderId;
            const name = 'ARCT-EXP' + req.query.id;

            if (dxpid.endsWith('"')) {
                dxpid = dxpid.substring(1, dxpid.length - 1)
            }
            if (dxpid.toUpperCase().indexOf('ARCT-EXP') == 0) {
                dxpid = dxpid.substring(8)
            }
            let signer = '' + req.query.signerEmail;
            let signerName = '' + req.query.signerName;
            if (signerName.endsWith('"')) {
                signerName = signerName.substring(1, signerName.length - 1);
            }
            if (signer.endsWith('"'))
                signer = signer.substring(1, signer.length - 1)
            let sign_status = '' + req.query.status;
            if (sign_status == null) {
                sign_status = 'pending'
            }
            try {
                console.log(' doc id ' + dxpid + ' --' + signer)
                const db_client = new Client(dbconfig)
                db_client.connect(
                    async err => {
                        if (err) {
                            console.log(JSON.stringify(err))
                            throw err;
                        }
                        else {
                            const sql1 = `SELECT signed from exp.elndoctrac where id = ${dxpid}`
                            const select_response = await db_client.query(sql1);

                            if (select_response.rowCount == 0) {
                                const doc_status = 'active';
                                const queryString = `INSERT INTO exp.elndoctrac(id, name, author, group_name, drive_id, doc_status, folder_id) VALUES ('${dxpid}','${name}','${author}','${group}','${drive_id}','${doc_status}','${folder_id}')`
                                db_client.query(queryString, async (err, _res: { rowCount?: any; }) => {
                                    if (err !== undefined && err != null) {
                                        console.log("Postgres INSERT error:", err);
                                        console.log("Postgres error position:", err);
                                    } else {
                                        const sql_new_signer = `update exp.elndoctrac set signed = '{"signers":{"${signer}":{"status":"${sign_status}","name":"${signerName}"}}}' where id = '${dxpid}'`;
                                        console.log(" adding single signer : " + sql_new_signer);
                                        const new_user_response = await db_client.query(sql_new_signer);
                                        return res.json(new_user_response);

                                    }
                                });

                            }
                            else
                                if (select_response == null || select_response.rows[0].signed == null) {
                                    const sql_new_signer = `update exp.elndoctrac set signed = '{"signers":{"${signer}":{"status":"${sign_status}","name":"${signerName}"}}}' where id = '${dxpid}'`;
                                    console.log(" adding single signer : " + sql_new_signer);
                                    const new_user_response = await db_client.query(sql_new_signer);
                                    return res.json(new_user_response);
                                } else {



                                    // ths is the old way
                                    // const sql = `update exp.elndoctrac set signed = jsonb_set (signed, '{"signers", "${signer}"}', '"${sign_status}"') where id = '${dxpid}'`

                                    // this will replace the signers
                                    // const sql = `update exp.elndoctrac set signed = jsonb_set (signed, '{"signers"}', '{"${signer}":{"status":"${sign_status}","name":"${signerName}"}}') where id = '${dxpid}'`


                                    const sql = `update exp.elndoctrac set signed = jsonb_set (signed, '{signers,${signer}}', '{"status":"${sign_status}","name":"${signerName}"}') where id = '${dxpid}'`
                                    console.log(sql);
                                    const update_user_response = await db_client.query(sql);
                                    return res.json(update_user_response);
                                }
                        }
                    }
                )

            } catch (exception) {
                console.log(exception)
            }
        })


        // app.get('/eln/get-sign-status', async (req: any, res: { json: (arg0: { rowCount?: any; }) => void; }) => {
        //     const dxpid = '' + req.query.id;
        //     const db_client = new Client(dbconfig)
        //     db_client.connect(
        //         async err => {
        //             if (err) {
        //                 console.log(JSON.stringify(err))
        //                 throw err;
        //             }
        //             else {
        //                 const sql = `select signed from exp.elndoctrac where id = ${dxpid}`
        //                 console.log(' sql : ' + sql)
        //                 db_client.query(sql, (err: any, _res: { rowCount?: any; }) => {
        //                     if (err !== undefined && err != null) {
        //                         console.log("Postgres query error:", err);
        //                         console.log("Postgres error position:", err);
        //                     }
        //                     if (_res !== undefined) {
        //                         res.json(_res)
        //                     }

        //                 });
        //             }
        //         }
        //     )
        // })
        app.get('/eln/list-signers', async (req: any, res: { json: any }) => {
            let dxpid = '' + req.query.id;
            if (dxpid.endsWith('"')) {
                dxpid = dxpid.substring(1, dxpid.length - 1)
            }
            if (dxpid.toUpperCase().indexOf('ARCT-EXP') == 0) {
                dxpid = dxpid.substring(8)
            }

            const db_client = new Client(dbconfig)
            db_client.connect(
                async err => {
                    if (err) {
                        console.log(JSON.stringify(err))
                        throw err;
                    }
                    else {
                        const sql1 = `SELECT signed from exp.elndoctrac where id = ${dxpid}`
                        console.log(" sql : " + sql1);
                        const select_response = await db_client.query(sql1);
                        if (select_response == null || select_response.rowCount == 0) {
                            return res.json({ 'count': 0 });
                        }
                        const rows = select_response.rows;
                        const obj = rows[0]
                        return res.json(obj);
                    }
                }
            )

        })


        app.get('/eln/remove-signer', async (req: any, res: { json: any }) => {
            let dxpid = '' + req.query.id;
            const signer = '' + req.query.signer;
            if (dxpid.endsWith('"')) {
                dxpid = dxpid.substring(1, dxpid.length - 1)
            }
            if (dxpid.toUpperCase().indexOf('ARCT-EXP') == 0) {
                dxpid = dxpid.substring(8)
            }

            const db_client = new Client(dbconfig)
            db_client.connect(
                async err => {
                    if (err) {
                        console.log(JSON.stringify(err))
                        return res.json(err);
                    }
                    else {
                        const sql1 = `update exp.elndoctrac set signed =  signed #- '{signers, ${signer}}'  where id = ${dxpid}`
                        const select_response = await db_client.query(sql1);
                        if (select_response == null || select_response.rowCount == 0) {
                            return res.json({ 'update': 'failed' });
                        }
                        const sql2 = `SELECT signed from exp.elndoctrac where id = ${dxpid}`
                        const select_response2 = await db_client.query(sql2);
                        if (select_response2 == null || select_response2.rowCount == 0 || select_response2.rows[0].signed == null) {
                            return res.json({ 'message': 'Failed.  Nothing found for ' + dxpid });
                        } else {
                            return res.json(select_response2);
                        }
                    }
                }
            )
            // return res.json({'message':'failed'});

        })

        app.post('/eln/create-doctrac', async (req: any, res: any) => {
            // const ppath = req.query.spath
            console.log(" Create Doc Trac ")
            const client = new Client(dbconfig)
            let author = '' + req.body.author;
            let name = '' + decodeURI(req.body.name);
            const group = req.body.group;
            const drive_id = req.body.drive_id;
            let folder_id = req.body.folder_id;
            if (folder_id == null || folder_id.length <= 0) {
                folder_id = 'not-defined-yet'
            }
            client.connect(
                err => {
                    if (err) {
                        console.log(JSON.stringify(err))
                        throw err;
                    }
                    else {
                        // queryDatabase();
                    }
                }
            )
            const doc_status = 'active';
            name = name.replace(/^"(.*)"$/, '$1');
            name = name.replace(/'/g, '');
            name = name.replace(/"/g, ' ');
            author = author.replace(/^"(.*)"$/, '$1');
            author = author.toLowerCase();
            const queryString = `INSERT INTO exp.elndoctrac(name, author, group_name, drive_id, doc_status, folder_id) VALUES ('${name}','${author}','${group}','${drive_id}','${doc_status}','${folder_id}')`
            client.query(queryString, (err, _res: { rowCount?: any; }) => {
                if (err !== undefined && err != null) {
                    console.log("Postgres INSERT error:", err);
                    console.log("Postgres error position:", err);
                }
                if (_res !== undefined) {
                    if (_res.rowCount > 0) {
                        client.query('select id from exp.elndoctrac order by date_created desc', (err, ores: { rowCount?: any; rows: any }) => {
                            if (ores.rows.length > 0) {
                                const idv = ores.rows[0].id
                                const sign_status = 'pending'
                                const sql = `update exp.elndoctrac set signed = jsonb_set (signed, '{"signers", "${author}"}', '"${sign_status}"') where id = ${idv}`
                                console.log(' sql : ' + sql)
                                client.query(sql, (err: any, _res: { rowCount?: any; }) => {
                                    if (err !== undefined && err != null) {
                                        console.log("Postgres INSERT error:", err);
                                        console.log("Postgres error position:", err);
                                    }
                                    if (_res !== undefined) {
                                        console.log("Updated signer as pending status. ")
                                    }
                                });
                                return res.json({ 'status': 'success', 'msg': 'id was crated', 'id': idv });
                            } else {
                                console.log(JSON.stringify(ores))
                                return res.json({ 'status': 'failed', 'msg': 'Insert into db failed' });
                            }
                        });
                    } else {
                        console.log("No records were inserted.");
                        return res.json({ 'status': 'failed', 'msg': 'Insert into db failed' });
                    }
                }

            });
        });
    }
}