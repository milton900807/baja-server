

export class CacheObj {
    name: string;
    obj: any;
    constructor(name: string, obj: any) {
        this.name = name;
        this.obj = obj;
    }
}

export class Cache {
    o: CacheObj[] = []
    public add(item: string, obj: any) {
        let index = 0;
        for (const it of this.o) {
            if (it.name === item) {
                this.o[index] = new CacheObj(item, obj);
                return;
            }
            index++;
        }
        this.o.push(new CacheObj(item, obj));
    }
    public get(item: string) {

        for (const it of this.o) {

            console.log ( ` sheet name ${it.name}`)
            if (it.name === item) {
                return it;
            }
        }
        return null;
    }
}

