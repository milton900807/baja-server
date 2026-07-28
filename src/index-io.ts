const fs = require("fs");
const chalk = require("chalk");

export class LJIO {

    static user = 'users_requests'

    static init() {
        console.log(" does the directory exist ");
        if (!fs.existsSync(LJIO.user)) {
            console.log("makding the directory ")
            fs.mkdirSync(LJIO.user);
        }
    }

    save(typedata: string, filename: string, data: any) {
        const scriptValue = JSON.stringify(data);
        if (typedata.trim() === 'user') {
            fs.writeFile(LJIO.user + '/' + filename, scriptValue, (err: any) => {
                if (err) return console.log(err);
            });
        }

    }

}
