import { Client } from "@microsoft/microsoft-graph-client";
require("isomorphic-fetch");

const MicrosoftGraph = require("@microsoft/microsoft-graph-client/lib/src/index.js");

export class MSGraph {
  static baseUrl = "https://graph.microsoft.com/v1.0";
  static fg_access_token: string;
  static seconds = 0;

  static async startTokenTimer(timeout: number) {
    MSGraph.seconds = timeout; // put a ten second buffer on this.
    return new Promise((resolve, _reject) => {
      const ti = setInterval(() => {
        MSGraph.seconds--;
        if (MSGraph.seconds % 100 == 0) {
          console.log(" Dev user token timer " + MSGraph.seconds + " - - ");
        }
        // console.log(" " + MSGraph.seconds + " - - ");
        if (MSGraph.seconds <= 0) {
          resolve("counter is done");
          clearInterval(ti);
        }
      }, 1000);
    });
  }
  static tokenExpired() {
    if (MSGraph.seconds <= 0) {
      return true;
    } else {
      return false;
    }
  }

}