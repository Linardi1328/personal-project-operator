import {readFile} from 'node:fs/promises'
// Static repository SQL loader only. Install before exposing service roles in
// a fresh disposable lab. This is not a live-authority migration or a driver.
const fragment=sql=>sql.replace(/^BEGIN;$/mu,'').replace(/^COMMIT;$/mu,'')
export async function admissionProfileSql({ownership=false}={}){
 const files=['phase1gd1-admission.sql',...(ownership?['phase1gd1-ownership-admission.sql']:[])]
 return 'BEGIN;\n'+(await Promise.all(files.map(f=>readFile(new URL(f,import.meta.url),'utf8')))).map(fragment).join('\n')+'\nCOMMIT;'
}
export async function admissionOwnershipSql(){
 const files=['phase1gb2-ownership-rehearsal.sql','phase1gd1-ownership-admission.sql']
 return 'BEGIN;\n'+(await Promise.all(files.map(f=>readFile(new URL(f,import.meta.url),'utf8')))).map(fragment).join('\n')+'\nCOMMIT;'
}
