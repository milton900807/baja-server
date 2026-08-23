import path from "path";

const fs = require("fs");
const chalk = require("chalk");


let trailscriptPath = '../baja-apps';

export class EnvConfig {
  static properties = EnvConfig.loadProperties();




  static loadProperties() {
    try {
      if (!fs.existsSync(trailscriptPath + '/flexigraph')) {
        trailscriptPath = '/baja';
      }

      const homedir = require("os").homedir();
      console.log("\tReading " + homedir + "/.ion-cli.config.json\n\n\n");
      const pproperties = JSON.parse(fs.readFileSync(homedir + "/.ion-cli.config.json"));
      console.log(" Properties : " + JSON.stringify(pproperties))
      return pproperties;
    } catch (exception) {
      console.log(
        chalk.red(
          "Warning:  No .ion-cli.config.json file found in your home directory.. Going with default settings."
        )
      );
      return {
        solrArray: "",
        devIndex: "http://a/document_index",
        host: "https://..com",
        ionworks: "https://..com"
      };
    }
  }
}

const homeDir = require("os").homedir();
const ljUsersDir = path.join(homeDir, 'baja-users');

function ensureLjUsersDirectory(ljUsersDir: any) {
  try {
    let error = fs.accessSync(ljUsersDir)
    if (error) {
      error = fs.mkdirSync(ljUsersDir, { recursive: true })
    }
  } catch (exception) {
    fs.mkdirSync(ljUsersDir, { recursive: true })
    return;
  }
}
ensureLjUsersDirectory(ljUsersDir);



export const environment = {
  HOST_LINK: 'https://localhost:4200',
  host: 'http://localhost',
  production: false,
  cache_filename: ".ion-cache.json",
  iondir: "/.ioncli",
  ionworks_publish_bucket: "ionworks",
  wd: trailscriptPath,
  devPath: trailscriptPath,
  htsFilesPath: trailscriptPath + '/data/hts',
  // Root directory holding big-data files (bigWig/VCF/etc.). Override with the
  // BIG_DATA environment variable; defaults to ~/baja-bd for this deployment.
  bigDataFilesPath: process.env.BIG_DATA || path.join(homeDir, 'baja-bd'),
  configPath: trailscriptPath + '/config',
  userData: ljUsersDir,
  ott_root: '/mnt/ott/genomes',
  // Root directory holding locally-built off-target 2-bit/seed indexes
  // (one subdirectory per index name). Lives alongside the reference FASTAs so
  // the download hook and the python search share one location. Override with
  // OFFTARGET_INDEX_DIR.
  offtarget_index_root: process.env.OFFTARGET_INDEX_DIR ||
    path.resolve('reference_data/offtarget_index')
};
