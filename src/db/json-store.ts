import * as fs from 'fs';

interface Database {
  [key: string]: any;
}

export class JsonDatabase {
  private databaseFilePath: string;

  constructor(databaseKey: string) {
    this.databaseFilePath = `${databaseKey}.json`;
  }

  private readDatabase(): Database {
    try {
      const data = fs.readFileSync(this.databaseFilePath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      // If the file doesn't exist or contains invalid JSON, return an empty object
      return {};
    }
  }

  private writeDatabase(data: Database): void {
    fs.writeFileSync(this.databaseFilePath, JSON.stringify(data, null, 2), 'utf8');
  }

  addObject(key: string, value: any): void {
    const database = this.readDatabase();
    database[key] = value;
    this.writeDatabase(database);
  }

  getObject(key: string): any {
    const database = this.readDatabase();
    return database[key];
  }
}

export default JsonDatabase;
