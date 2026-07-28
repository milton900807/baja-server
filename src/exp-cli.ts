
import { environment, EnvConfig } from "./environment";
import express, { query } from "express";
import cors from "cors";
import simpleGit, { GitConstructError, ResetMode } from "simple-git"
import fs from 'fs'
import bodyParser, { json } from 'body-parser'
import dirTree from 'directory-tree'
import { Pool, Client } from 'pg'
import { MSGraph } from "./msgraph-proxy";

const fsp = require('fs').promises;
const app = express();
const port = 8080; // default port to listen
app.use(bodyParser.json());
app.use(cors())
const wd = '../ionscript'
const git = simpleGit(wd)
const dbconfig = {
    host: 'eln-db.postgres.database.azure.com',
    // Do not hard code your username and password.
    // Consider using Node environment variables.
    user: 'arctadmin@eln-db',
    password: 'sp3arGunner!!',
    database: 'test',
    port: 5432,
    ssl: true
}

const exec = require("child_process").exec;
const http = require("http");
const chalk = require("chalk");
const figlet = require("figlet");
const program = require("commander");
const colors = require("colors");
const FileSystem = require("fs");
const Path = require("path");
const PropertiesReader = require("properties-reader");

console.log(chalk.red(figlet.textSync("ION-CLI", { horizontalLayout: "full" })));
console.log(chalk.green(' Run "ion --help" for a list of available commands '));
console.log("args:" + process.argv);



/**
 *  List the files that are in a folder on one drive
 */
program
    .command("ls <path>")
    .option("-r, --depth <depth>", " List the files recursively to a certain depth")
    .option("-t, --filetypes <filetypes>", " List the files of type")
    .option("-s, --sizelimit <sizelimit>", " List the files under a specific file size in MB")
    .action(async function (path: string, args: { depth: number; filetypes: string; sizelimit: number }) {
        try {
            console.log(" Reading path : " + path + " with size limit " + args.sizelimit);
            let file_types: string[] = [];
            if (args.filetypes == null || args.filetypes.length == 0) {
                args.filetypes = "xlsx,xlsm,pdf,ppt,doc,docx,xls,txt,csv";
            }

            const filetypes = args.filetypes;

            if (filetypes != undefined && filetypes.length > 0) {
                file_types = filetypes.split(",");
            }

            const files = readDirR(path, file_types, args.sizelimit);
            let index = 0;
            for (const f of files) {
                console.log("File : " + f);
                const progress = Math.round((index++ / files.length) * 100);
                if (progress % 5 === 0) console.log("\t\t#### " + progress);
            }
        } catch (exception) {
            console.log(exception);
        }
    });


function __readDirR(dir: any, fileTypes: string[]) {
    return FileSystem.statSync(dir).isDirectory()
        ? ((_dir: any, _fileTypes: string[]) => {
            if (_dir != undefined) {
                return Array.prototype.concat(
                    ...FileSystem.readdirSync(_dir).map((f: any) => __readDirR(Path.join(_dir, f), _fileTypes))
                );
            }
        })(dir, fileTypes)
        : ((dir: any, fileTypes: string[]) => {
            for (const f of fileTypes) {
                if (dir.toLowerCase().endsWith(f.toLowerCase())) {
                    return dir;
                }
            }
        })(dir, fileTypes);
}


function readDirR(dir: any, fileTypes: string[], sizelimit: number) {
    // console.log ( fileTypes )
    const files = __readDirR(dir, fileTypes);
    const index = 0;
    const df = [];
    for (const f of files) {
        if (f != undefined) {
            if (sizelimit) {
                try {
                    const stats = fs.statSync(f);
                    const fileSizeInBytes = stats.size;
                    const fileSizeInMegabytes = fileSizeInBytes / 1000000.0;
                    // console.log(fileSizeInMegabytes);
                    if (sizelimit > fileSizeInMegabytes) {
                        df.push(f);
                    }
                } catch (exception) {
                    console.error(" Failed to get the stats for file " + f + ".  Skipping this file");
                    console.trace();
                }
            } else {
                df.push(f);
            }
        }
    }
    return df;
}

program
    .command("exps")
    .option("-p, --path <path>", " ")
    .action(async function (_args: { path: string }) {
    });







program.parse(process.argv);
export let processComplete = false;
module.exports = {
    go (cmd: string, args: any) {
        return new Promise((resolve, reject) => {
            let output = "";
            const { exec } = require("child_process");
            let exec_text = "ion " + cmd;
            if (args != null && args.length > 0) {
                exec_text += " " + args;
            }

            // console.log ( ' command : ' + exec_text );
            // console.log ( ' args : ' + args );
            const subprocess = exec(exec_text, function (
                error: { stack: any; code: string; signal: string },
                stdout: string,
                stderr: string
            ) {
                if (error) {
                    console.log(error.stack);
                    console.log("Error code: " + error.code);
                    console.log("Signal received: " + error.signal);
                }
                // console.log("Child Process STDOUT: " + stdout);
                // console.log("Child Process STDERR: " + stderr);
                if (stdout != null && stdout.length > 0) {
                    resolve(stdout);
                }
            });
            const originalStdoutWrite = subprocess.stdout.write.bind(subprocess.stdout);
            subprocess.stdout.write = (
                str: string | Uint8Array,
                encoding?: string | any,
                cb?: ((err?: Error | undefined) => void) | undefined
            ) => {
                if (str != undefined) {
                    output += str;
                }
                return originalStdoutWrite(str, encoding, cb);
            };
            subprocess.on("close", () => {
                resolve(output);
            });
        });
    },
    memgo (path: string, args: any) {
        return new Promise((resolve, reject) => {
            //   resolve(ionworks.run(path, args));
        });
    },
    runcommand (cmd: string, args: any) {
        return new Promise((resolve, reject) => {
            //   resolve(ionworks.run(cmd, args));
        });
    },
};
function newFunction() {
    debugger;
}



