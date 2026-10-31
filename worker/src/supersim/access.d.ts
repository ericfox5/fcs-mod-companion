export const SESSION_COOKIE: string;
export function issueSession(secret:string,identity:{dynastyId:number;blazeId:number},now?:number):Promise<string>;
export function verifySession(req:Request,secret:string|undefined,now?:number):Promise<{v:number;dynastyId:number;blazeId:number;iat:number;exp:number}|null>;
export function allowedGame(dyn:any,member:any,game:any):boolean;
export function sameOrigin(req:Request):boolean;
