// Validate bounded JSON text before returning any last-key-wins parsed value.
// Each object owns a separate key set; decoded spellings are compared, so
// escaped equivalent names collide while names in sibling objects do not.
export function parseUniqueJson(source,{maxBytes=131072,maxDepth=128}={}){
  if(typeof source!=="string"||Buffer.byteLength(source,"utf8")>maxBytes)throw Error("Invalid bounded JSON.")
  const stack=[]
  for(let i=0;i<source.length;i++){
    const char=source[i]
    if(char==='"'){
      const start=i
      for(i++;i<source.length;i++){
        if(source[i]==="\\"){i++;continue}
        if(source[i]==='"')break
      }
      const frame=stack.at(-1)
      if(frame?.keys&&frame.expectKey){
        const key=JSON.parse(source.slice(start,i+1))
        if(frame.keys.has(key))throw Error("Duplicate JSON property.")
        frame.keys.add(key)
        frame.expectKey=false
      }
    }else if(char==="{"||char==="["){
      if(stack.length>=maxDepth)throw Error("JSON nesting exceeds bound.")
      stack.push(char==="{"?{keys:new Set(),expectKey:true}:{keys:null})
    }else if(char==="}"||char==="]"){
      stack.pop()
    }else if(char===","&&stack.at(-1)?.keys){
      stack.at(-1).expectKey=true
    }
  }
  return JSON.parse(source) // establish full grammar; no normalization yet
}
