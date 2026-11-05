/** Isolated UI fixture only: no warehouse connection is ever opened. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export async function createAuditFixture(base, directory) {
  const origin = new URL(base).origin;
  // An ordinary failed sign-in initializes additive migrations without sending email.
  await fetch(`${base}/api/auth/sign-in`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ email: "fixture@example.test", password: "unusable-fixture-password" }) });
  const db = new DatabaseSync(join(directory, "dataforge.db"));
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  const now = new Date().toISOString(), userId = randomUUID(), sessionId = randomUUID(), token = randomBytes(32).toString("base64url");
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  db.prepare("INSERT INTO users(id,email,password_hash,email_verified_at,name,created_at) VALUES(?,?,?,?,?,?)").run(userId,"ui-audit@example.test","unusable UI-only fixture hash",now,"Readability audit owner",now);
  db.prepare("UPDATE workspaces SET created_by=?,name=? WHERE id=?").run(userId,"A long workspace name for readability and wrapping",workspaceId);
  db.prepare("INSERT INTO memberships(workspace_id,user_id,role) VALUES(?,?,'owner')").run(workspaceId,userId);
  db.prepare("INSERT INTO sessions(id,user_id,token_hash,expires_at,ip,user_agent,created_at,workspace_id) VALUES(?,?,?,?,?,?,?,?)").run(sessionId,userId,createHash("sha256").update(token).digest("hex"),new Date(Date.now()+86400000).toISOString(),"direct","DataForge offline UI audit",now,workspaceId);
  const headers = {Cookie:`dataforge_session=${token}`,Origin:origin};
  const request = async (path,method="GET",body) => {
    const response = await fetch(`${base}${path}`,{method,headers:{...headers,...(body===undefined||body instanceof FormData?{}:{"Content-Type":"application/json"})},...(body===undefined?{}:{body:body instanceof FormData?body:JSON.stringify(body)})});
    const text=await response.text();assert(response.ok,`${method} ${path}: ${response.status} ${text.slice(0,500)}`);return JSON.parse(text);
  };
  const upload = new FormData();upload.set("name","Superstore — a long project name for zoom and mobile readability");upload.set("file",new File([await readFile(join(process.cwd(),"samples/superstore_sales.csv"))],"superstore_sales.csv",{type:"text/csv"}));
  const {project}=await request("/api/projects","POST",upload), projectId=project.id;
  // This credential points at a closed local port. All browser query routes are doubled.
  await request("/api/settings/connection","PUT",{server:"127.0.0.1",port:1,database:"UI_AUDIT_ONLY",user:"offline-audit",password:randomBytes(24).toString("base64"),encrypt:true,trustServerCertificate:true,stagingFolder:directory});
  const loadId=randomUUID();
  db.prepare("INSERT INTO runs(id,project_id,status,mode,started_at,finished_at,rows_staged,rows_loaded,rows_rejected,options_json,workspace_id) VALUES(?,?,'succeeded','full',?,?,?,?,?,?,?)").run(loadId,projectId,now,now,project.rowCount,project.rowCount,0,JSON.stringify({db:"UI_AUDIT_ONLY",dedupe:false,incremental:false}),workspaceId);
  for(const [ordinal,file] of ["00_setup.sql","01_staging.sql","02_dimensions.sql","03_fact.sql","04_load.sql","05_checks.sql"].entries())db.prepare("INSERT INTO run_steps(run_id,ordinal,file,status,started_at,finished_at,rows_affected,message) VALUES(?,?,?,'succeeded',?,?,?,?)").run(loadId,ordinal,file,now,now,ordinal===4?project.rowCount:0,"Offline UI fixture; SQL was not executed.");
  db.prepare("INSERT INTO run_logs(run_id,ts,level,message) VALUES(?,?,'INFO',?)").run(loadId,now,"Offline UI fixture; no warehouse connection was opened.");
  const model=await request(`/api/projects/${projectId}/semantic`);
  const sales=model.measures.find(m=>/^sales$/i.test(m.name))??model.measures[0];
  const category=model.tables.flatMap(t=>t.columns.map(c=>({table:t,column:c}))).find(v=>/^category$/i.test(v.column.name))??model.tables.filter(t=>t.kind==="dimension").flatMap(t=>t.columns.filter(c=>c.role==="attribute").map(c=>({table:t,column:c})))[0];
  const attribute={table:category.table.id,column:category.column.id};
  const config={version:1,viz:"bar",rows:[attribute],columns:[],values:[sales.id],filters:[],sort:[],options:{title:"Sales by product category — full labels remain available",numberFormat:"auto",showTotals:true,seriesColors:[],barOrientation:"vertical",stacked:false,showLegend:true}};
  const view=await request(`/api/projects/${projectId}/explore/views`,"POST",{name:"Sales by category with a deliberately long view name",config});
  const tileBase={x:0,y:0,w:6,h:4,title:"Sales by category with long labels",subtitle:"Offline browser-driver data",numberFormat:"auto",showLegend:true};
  const dashboard=await request(`/api/projects/${projectId}/dashboards`,"POST",{name:"Superstore readability dashboard",description:"A representative dashboard with chart, KPI, note and slicer.",layout:{version:1,tiles:[{...tileBase,id:"chart",type:"chart",source:{kind:"view",viewId:view.id}},{...tileBase,id:"kpi",x:6,type:"kpi",title:"Total Sales",measure:sales.id},{...tileBase,id:"note",y:4,type:"text",content:"## Readable information\nLong names, null values and negative amounts remain visible at every text size."},{...tileBase,id:"slicer",x:6,y:4,type:"slicer",title:"Category filter",attribute}]},filters:{version:1,items:[]},settings:{version:1,crossFiltering:true,autoRefreshMinutes:0}});
  const report=await request(`/api/projects/${projectId}/reports`,"POST",{name:"Superstore readability report",description:"Representative table, chart and report settings.",definition:{version:1,page:{size:"A4",orientation:"portrait",margins:{top:36,right:36,bottom:36,left:36}},header:{title:"Sales by category",subtitle:"Readable at every zoom level",text:"",showRunDate:true,showParameters:true},footer:{text:"Offline UI fixture",showPageNumbers:true},parameters:[],retentionCount:20,items:[{id:"sales-table",type:"table",title:"Sales by category",data:{kind:"fields",rows:[attribute],values:[sales.id],filters:[],sort:[]},columns:[{id:"category",label:"Category",width:180,align:"left",format:"auto",binding:{kind:"attribute",attribute}},{id:"sales",label:"Sales",width:120,align:"right",format:"currency",binding:{kind:"measure",measure:sales.id}}],groups:[attribute],subtotals:true,grandTotal:true,keepTogether:true,hideOnEmpty:false,conditionalFormats:[]},{id:"report-text",type:"text",title:"Readability notes",content:"Long labels wrap, amounts retain their meaning, and controls remain keyboard accessible."}]}});
  const checkId=randomUUID(),result={id:"semantic.sales",area:"Semantic",name:"Sales total matches the independent reference",status:"pass",expected:1485523.86,actual:1485523.86,difference:0,tolerance:0.01,elapsedMs:12,explanation:"Browser fixture for reading detailed reconciliation evidence. No SQL was executed.",nextStep:"Run live checks locally to verify the warehouse.",sql:"SELECT SUM([Sales]) FROM [dw].[fact_sales]",referenceSql:"SELECT SUM([f].[Sales]) AS [expected] FROM [dw].[fact_sales] AS [f]"};
  db.prepare("INSERT INTO verification_runs(id,project_id,workspace_id,user_id,source_run_id,model_version,status,trigger,started_at,finished_at,total,completed,counts_json,snapshot_json) VALUES(?,?,?,?,?,?,'succeeded','manual',?,?,1,1,?,?)").run(checkId,projectId,workspaceId,userId,loadId,model.version,now,now,JSON.stringify({pass:1,warn:0,fail:0,skipped:0}),JSON.stringify({version:1,data:{}}));
  db.prepare("INSERT INTO verification_results(run_id,ordinal,result_id,result_json) VALUES(?,0,?,?)").run(checkId,result.id,JSON.stringify(result));
  db.close();
  return {projectId,dashboardId:dashboard.id,reportId:report.id,viewId:view.id,checkId,loadId,model,token,attribute,sales:sales.id};
}

export function queryDouble(model,input={}) {
  const attributes=[...(input.rows??[]),...(input.columns??[])];
  const measures=input.measures??[];
  const findColumn=ref=>model.tables.find(t=>t.id===ref.table||t.name===ref.table)?.columns.find(c=>c.id===ref.column||c.name===ref.column);
  const columns=[...attributes.map((ref,i)=>({key:`g${i}`,name:findColumn(ref)?.name??ref.column,type:findColumn(ref)?.type??"string",role:"attribute"})),...measures.map((id,i)=>({key:`v${i}`,name:model.measures.find(m=>m.id===id||m.name===id)?.name??id,type:"number",role:"measure"}))];
  const rows=Array.from({length:attributes.length?3:1},(_,row)=>Object.fromEntries(columns.map((column,index)=>[column.key,column.role==="measure"?(row===1?-107597.24:row===2?573276.66:1214651.07):/year/i.test(column.name)?2022+row:/date/i.test(column.name)?`202${row+2}-01-01`:row===0?"Furniture and unusually long category label for mobile layouts":row===1?"Office Supplies":null])));
  return {columns,rows,rowCount:rows.length,truncated:false,elapsedMs:12,fromCache:false,sql:"-- Offline browser driver double\nSELECT [Category], SUM([Sales]) AS [Sales] FROM [dw].[fact_sales] GROUP BY [Category]",params:[],timings:{queueMs:0,parseMs:1,compileMs:1,cacheLookupMs:0,poolAcquireMs:1,connectMs:0,sendToFirstRowMs:7,fetchMs:2,totalMs:12}};
}
