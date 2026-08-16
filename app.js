/* ============================================================================
   LICONSUMAR · App de Entregas / Devoluciones / Cuadre de Ruta
   ============================================================================ */

/* ---------------------------- Constantes ---------------------------- */
const CAUSALES = [
  "1. Sin dinero", "2. Error de digitación", "3. Error de despacho",
  "4. No hizo pedido", "5. O.C cerrada", "6. Cliente ausente",
  "7. Pto pte por estampillar", "8. Fecha de vencimiento", "9. Avería en transporte",
  "10. Establecimiento cerrado", "11. Problemas de calidad", "12. Dev total factura"
];
const FORMAS_PAGO = [
  { v:"mixta_transferencia", l:"Mixta Transferencia" },
  { v:"mixta_efectivo",      l:"Mixta Efectivo" },
  { v:"efectivo",            l:"Efectivo" },
  { v:"credito",             l:"Crédito" },
  { v:"transferencia",       l:"Transferencia" },
  { v:"saldo_favor",         l:"Saldo a Favor" },
  { v:"retenciones",         l:"Retenciones" },
];
const ESTADOS = {
  pendiente:  { label:"Pendiente",  badge:"badge-pend",   dot:"dot-pend"  },
  ok:         { label:"OK",         badge:"badge-ok",     dot:"dot-ok"    },
  dev_parcial:{ label:"Dev. Parcial", badge:"badge-warn", dot:"dot-warn"  },
  dev_total:  { label:"Dev. Total", badge:"badge-danger", dot:"dot-danger"},
};
const DEFAULT_VENDEDORES = ["Milena Morales","Cárdenas Iglesias","Helmut","Jesús Gómez","Ana Orozco"];
const LS_KEY = "liconsumar_ruta_v1";

/* ---------------------------- Estado ---------------------------- */
let state = loadState();

function emptyState(){
  return {
    ruta: { fecha: todayISO(), entregador:"", placa:"", numeroPlanilla:"", valorTotalPlanilla:0, ctaTotalFacturas:0, dineroEntregadoCaja:0 },
    facturas: [],
    devoluciones: [],
    reenvios: [],
    clientes: [],
    vendedores: DEFAULT_VENDEDORES.slice(),
  };
}

function loadState(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(!raw) return emptyState();
    const parsed = JSON.parse(raw);
    return Object.assign(emptyState(), parsed);
  }catch(e){ return emptyState(); }
}
function saveState(){ localStorage.setItem(LS_KEY, JSON.stringify(state)); }

/* ---------------------------- Utilidades ---------------------------- */
function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,8); }
function todayISO(){ return new Date().toISOString().slice(0,10); }
function fmt(n){
  n = Number(n)||0;
  return "$" + n.toLocaleString('es-CO', {maximumFractionDigits:0});
}
function num(v){ const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function esc(s){ return (s==null?"":String(s)).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function toast(msg, type){
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' '+type : '');
  el.innerHTML = msg;
  document.body.appendChild(el);
  setTimeout(()=>{ el.style.transition='opacity .4s'; el.style.opacity='0'; setTimeout(()=>el.remove(), 400); }, 3200);
}

function mapEmbedUrl(direccion, barrio, ciudad){
  const q = encodeURIComponent(`${direccion||''}, ${barrio||''}, ${ciudad||'Santa Marta'}, Magdalena, Colombia`);
  return `https://maps.google.com/maps?q=${q}&z=15&output=embed`;
}

/* Recalcula el total final de una factura después de descuentos */
function facturaTotalFinal(f){
  let total = f.productos.reduce((s,p)=> s + (num(p.valorTotal) || num(p.valorNeto)*num(p.cantidad)), 0);
  if(!total) total = num(f.valorTotalFactura);
  if(f.estado === 'dev_total') return 0;
  if(f.estado === 'dev_parcial'){
    const devuelto = f.productos.reduce((s,p)=> s + (p.devuelta ? (num(p.cantidadDevuelta) * (num(p.valorNeto)|| (num(p.valorTotal)/Math.max(num(p.cantidad),1)))) : 0), 0);
    total = total - devuelto;
  }
  total = total - num(f.saldoFavor) - num(f.retenciones);
  return Math.max(total, 0);
}

/* ---------------------------- Supabase ---------------------------- */
async function sbInsert(table, rows){
  const res = await fetch(`${window.SUPABASE_URL}/rest/v1/${table}`, {
    method:'POST',
    headers:{
      'apikey': window.SUPABASE_KEY,
      'Authorization':'Bearer ' + window.SUPABASE_KEY,
      'Content-Type':'application/json',
      'Prefer':'return=representation'
    },
    body: JSON.stringify(rows)
  });
  if(!res.ok){ const t = await res.text(); throw new Error(`${table}: ${t}`); }
  return res.json();
}

async function guardarClienteEnSupabase(c){
  try{
    await sbInsert('clientes', [{
      nombre_cliente: c.nombre, nombre_negocio: c.negocio, telefono: c.telefono,
      direccion: c.direccion, horario: c.horario, vendedor: c.vendedor
    }]);
  }catch(e){ console.warn('No se pudo sincronizar cliente con Supabase', e); }
}

async function guardarRutaCompleta(){
  const btn = document.getElementById('btnSaveRoute');
  const original = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span> Guardando...';
  btn.setAttribute('disabled','disabled');
  try{
    const r = state.ruta;
    const [rutaRow] = await sbInsert('rutas', [{
      fecha: r.fecha || null, entregador: r.entregador, placa: r.placa,
      numero_planilla: r.numeroPlanilla,
      valor_total_planilla: num(r.valorTotalPlanilla),
      cta_total_facturas: state.facturas.length,
      total_efectivo: cuadreTotales().totalEfectivo,
      total_a_legalizar: cuadreTotales().totalALegalizar,
      dinero_entregado_caja: num(r.dineroEntregadoCaja)
    }]);
    const rutaId = rutaRow.id;

    for(const f of state.facturas){
      const [facRow] = await sbInsert('facturas', [{
        ruta_id: rutaId, factura: f.factura, barrio: f.barrio, direccion: f.direccion,
        ciudad: f.ciudad || 'Santa Marta',
        valor_total_original: num(f.valorTotalFactura),
        valor_total_final: facturaTotalFinal(f),
        estado_entrega: f.estado, forma_pago: f.formaPago,
        saldo_favor: num(f.saldoFavor), retenciones: num(f.retenciones),
        vendedor: f.vendedor, causal: f.causal, firma_cliente: f.firma || null
      }]);
      if(f.productos && f.productos.length){
        await sbInsert('factura_productos', f.productos.map(p=>({
          factura_id: facRow.id, producto: p.producto, cantidad: num(p.cantidad),
          valor_neto: num(p.valorNeto), valor_total: num(p.valorTotal),
          devuelto: !!p.devuelta, cantidad_devuelta: num(p.cantidadDevuelta)
        })));
      }
    }

    if(state.devoluciones.length){
      await sbInsert('devoluciones', state.devoluciones.map(d=>({
        ruta_id: rutaId, fecha: d.fecha || null, placa: d.placa, cliente: d.cliente,
        factura: d.factura, asesor_comercial: d.asesor, causal: d.causal,
        codigo_producto: d.codigoProducto, descripcion: d.descripcion,
        cantidad_botellas: num(d.cantidad), firma_cliente: d.firma || null
      })));
    }
    if(state.reenvios.length){
      await sbInsert('reenvios', state.reenvios.map(rv=>({
        ruta_id: rutaId, numero_factura: rv.numeroFactura, total_factura: num(rv.totalFactura)
      })));
    }

    toast('✅ Ruta guardada en Supabase correctamente. Iniciando ruta nueva...', 'ok');
    resetRuta(false);
  }catch(e){
    console.error(e);
    toast('⚠️ Error al guardar en Supabase: ' + e.message + '. Revisa tu conexión / esquema.', 'err');
  }finally{
    btn.innerHTML = original;
    btn.removeAttribute('disabled');
  }
}

function resetRuta(confirmFirst){
  const doReset = () => {
    const keepClientes = state.clientes;
    const keepVendedores = state.vendedores;
    state = emptyState();
    state.clientes = keepClientes;
    state.vendedores = keepVendedores;
    saveState();
    render();
  };
  if(confirmFirst){
    if(confirm('¿Seguro que deseas limpiar todos los registros de la ruta actual (facturas, devoluciones y reenvíos)? Esta acción no se puede deshacer. La base de clientes NO se borrará.')){
      doReset();
      toast('🗑️ Registros de la ruta limpiados.');
    }
  } else {
    doReset();
  }
}

/* ============================================================================
   NAVEGACIÓN / RENDER SHELL
   ============================================================================ */
let currentTab = 'entregas';
const TAB_TITLES = { entregas:'1 · Entregas', devoluciones:'2 · Devolución', cuadre:'3 · Cuadre de ruta', reenvios:'4 · Reenvíos', clientes:'5 · Clientes' };

function switchTab(tab){
  currentTab = tab;
  document.querySelectorAll('.navtabs button').forEach(b=> b.classList.toggle('active', b.dataset.tab===tab));
  document.getElementById('mobileTitle').textContent = TAB_TITLES[tab];
  document.getElementById('sidebar').classList.remove('open');
  render();
}

function render(){
  const view = document.getElementById('view');
  if(currentTab==='entregas') view.innerHTML = renderEntregas();
  else if(currentTab==='devoluciones') view.innerHTML = renderDevoluciones();
  else if(currentTab==='cuadre') view.innerHTML = renderCuadre();
  else if(currentTab==='reenvios') view.innerHTML = renderReenvios();
  else if(currentTab==='clientes') view.innerHTML = renderClientes();
  wireGlobalHandlers();
}

/* ============================================================================
   SECCIÓN 1 · ENTREGAS
   ============================================================================ */
let entregasFilter = { q:'', estado:'todos', groupBy:'ninguno' };
let openCards = new Set();

function dashboardStats(){
  const f = state.facturas;
  const total = f.length;
  const ok = f.filter(x=>x.estado==='ok').length;
  const parcial = f.filter(x=>x.estado==='dev_parcial').length;
  const totalDev = f.filter(x=>x.estado==='dev_total').length;
  const pend = f.filter(x=>x.estado==='pendiente').length;
  const valorTotal = f.reduce((s,x)=> s + facturaTotalFinal(x), 0);
  return { total, ok, parcial, totalDev, pend, valorTotal };
}

function renderEntregas(){
  const st = dashboardStats();
  const r = state.ruta;

  const facturasFiltradas = state.facturas.filter(f=>{
    if(entregasFilter.estado!=='todos' && f.estado!==entregasFilter.estado) return false;
    if(entregasFilter.q){
      const q = entregasFilter.q.toLowerCase();
      if(!(String(f.factura||'').toLowerCase().includes(q) || String(f.barrio||'').toLowerCase().includes(q) || String(f.direccion||'').toLowerCase().includes(q))) return false;
    }
    return true;
  });

  let groups = { "Todas las facturas": facturasFiltradas };
  if(entregasFilter.groupBy==='barrio'){
    groups = {};
    facturasFiltradas.forEach(f=>{ const k=f.barrio||'Sin barrio'; (groups[k]=groups[k]||[]).push(f); });
  } else if(entregasFilter.groupBy==='estado'){
    groups = {};
    facturasFiltradas.forEach(f=>{ const k=ESTADOS[f.estado].label; (groups[k]=groups[k]||[]).push(f); });
  }

  return `
  <div class="topbar">
    <div><h2>Entregas de productos</h2><p>Carga la planilla, gestiona cada factura y confirma la entrega en campo.</p></div>
    <div class="pill">📅 ${esc(r.fecha||'—')} &nbsp;·&nbsp; 🚚 ${esc(r.placa||'—')} &nbsp;·&nbsp; 👤 ${esc(r.entregador||'—')}</div>
  </div>

  <div class="dashboard-strip">
    <div class="dstat"><b>${st.total}</b><span>Facturas cargadas</span></div>
    <div class="dstat"><b style="color:var(--ok)">${st.ok}</b><span>Entregas OK</span></div>
    <div class="dstat"><b style="color:var(--warn)">${st.parcial}</b><span>Dev. parciales</span></div>
    <div class="dstat"><b style="color:var(--danger)">${st.totalDev}</b><span>Dev. totales</span></div>
    <div class="dstat"><b class="mono">${fmt(st.valorTotal)}</b><span>Valor neto ruta</span></div>
  </div>

  <div class="card">
    <h3><span class="tag">1</span> Datos de la ruta y cargue de planilla</h3>
    <div class="grid cols-6">
      <div class="field"><label>Entregador</label><input type="text" id="rEntregador" value="${esc(r.entregador)}"></div>
      <div class="field"><label>Placa vehículo</label><input type="text" id="rPlaca" value="${esc(r.placa)}"></div>
      <div class="field"><label>Fecha</label><input type="date" id="rFecha" value="${esc(r.fecha)}"></div>
      <div class="field"><label>N° planilla</label><input type="text" id="rPlanilla" value="${esc(r.numeroPlanilla)}"></div>
      <div class="field"><label>Valor total factura(s)</label><input type="number" id="rValorTotal" value="${r.valorTotalPlanilla||0}"></div>
      <div class="field"><label>Cta. total facturas</label><input type="number" id="rCtaTotal" value="${r.ctaTotalFacturas||state.facturas.length||0}" placeholder="auto"></div>
    </div>
    <div class="divider"></div>
    <label>Subir archivo Excel "entregas productos"</label>
    <div class="upload-box" id="uploadBox">
      <input type="file" id="fileInput" accept=".xlsx,.xls">
      <div>📤 <strong>Haz clic o arrastra</strong> el archivo Excel de entregas (detalle por factura)</div>
      <div class="section-note">Se agrupan automáticamente los productos por número de factura (FVE).</div>
    </div>
  </div>

  <div class="card">
    <div class="flexrow between">
      <h3 style="margin:0"><span class="tag">2</span> Facturas de la ruta (${facturasFiltradas.length})</h3>
      <div class="flexrow">
        <input type="text" id="fSearch" placeholder="Buscar factura, barrio o dirección..." style="width:230px" value="${esc(entregasFilter.q)}">
        <select id="fEstadoFilter">
          <option value="todos" ${entregasFilter.estado==='todos'?'selected':''}>Todos los estados</option>
          <option value="pendiente" ${entregasFilter.estado==='pendiente'?'selected':''}>Pendiente</option>
          <option value="ok" ${entregasFilter.estado==='ok'?'selected':''}>OK</option>
          <option value="dev_parcial" ${entregasFilter.estado==='dev_parcial'?'selected':''}>Dev. parcial</option>
          <option value="dev_total" ${entregasFilter.estado==='dev_total'?'selected':''}>Dev. total</option>
        </select>
        <select id="fGroupBy">
          <option value="ninguno" ${entregasFilter.groupBy==='ninguno'?'selected':''}>Sin agrupar</option>
          <option value="barrio" ${entregasFilter.groupBy==='barrio'?'selected':''}>Agrupar por barrio</option>
          <option value="estado" ${entregasFilter.groupBy==='estado'?'selected':''}>Agrupar por estado</option>
        </select>
        <button class="btn btn-amber btn-sm" id="btnAddFactura">+ Factura manual</button>
      </div>
    </div>
    ${facturasFiltradas.length===0 ? '<p class="section-note">No hay facturas todavía. Sube un archivo Excel o agrega una factura manual.</p>' : ''}
    ${Object.entries(groups).map(([g, arr])=> arr.length? `
      ${entregasFilter.groupBy!=='ninguno' ? `<div style="font-weight:800; color:var(--navy); margin:14px 0 8px; font-size:12.5px; text-transform:uppercase; letter-spacing:.4px;">${esc(g)} <span style="color:var(--muted); font-weight:600;">(${arr.length})</span></div>` : ''}
      ${arr.map(f=>renderFacturaCard(f)).join('')}
    `:'').join('')}
  </div>
  `;
}

function renderFacturaCard(f){
  const est = ESTADOS[f.estado] || ESTADOS.pendiente;
  const isOpen = openCards.has(f.id);
  const totalFinal = facturaTotalFinal(f);
  const locked = f.confirmado;

  return `
  <div class="factura-card ${locked?'confirmed':''}" data-fid="${f.id}">
    <div class="fhead" data-toggle="${f.id}">
      <div class="left">
        <span class="mono fnum">#${esc(f.factura||'S/N')}</span>
        <span class="fmeta">📍 ${esc(f.barrio||'')} — ${esc(f.direccion||'')}</span>
        <span class="badge ${est.badge}"><span class="dot ${est.dot}"></span>${est.label}${locked?' · confirmada':''}</span>
      </div>
      <div class="flexrow">
        <span class="ftotal mono">${fmt(totalFinal)}</span>
        <button class="icon-btn" data-action="share-jpg" data-fid="${f.id}" title="Compartir JPG">🖼️</button>
        <button class="icon-btn" data-action="del-factura" data-fid="${f.id}" title="Eliminar factura">🗑️</button>
        <span>${isOpen?'▲':'▼'}</span>
      </div>
    </div>
    <div class="factura-body ${isOpen?'open':''}" id="fbody-${f.id}">
      ${renderFacturaBody(f)}
    </div>
  </div>`;
}

function renderFacturaBody(f){
  const locked = f.confirmado;
  const disabledAttr = locked ? 'disabled' : '';
  const vendedores = state.vendedores;

  return `
    <div class="grid cols-3" style="margin-bottom:10px;">
      <div class="field"><label>N° Factura</label><input type="text" class="editcell" data-f="factura" value="${esc(f.factura)}" ${disabledAttr}></div>
      <div class="field"><label>Barrio</label><input type="text" class="editcell" data-f="barrio" value="${esc(f.barrio)}" ${disabledAttr}></div>
      <div class="field"><label>Dirección</label><input type="text" class="editcell" data-f="direccion" value="${esc(f.direccion)}" ${disabledAttr}></div>
    </div>
    <button class="btn btn-outline btn-sm" data-action="toggle-map" data-fid="${f.id}">🗺️ Ver ubicación GPS en el mapa</button>
    <div id="mapwrap-${f.id}"></div>

    <div class="divider"></div>
    <div class="flexrow between">
      <label style="margin:0">Productos de la factura</label>
      ${!locked ? `<button class="btn btn-outline btn-sm" data-action="add-producto" data-fid="${f.id}">+ Agregar producto</button>` : ''}
    </div>
    <table class="gridtable" style="margin-top:6px;">
      <thead><tr><th>Producto</th><th class="num">Cantidad</th><th class="num">Vlr. Unit.</th><th class="num">Vlr. Total</th>${!locked?'<th></th>':''}</tr></thead>
      <tbody>
        ${f.productos.map(p=>`
          <tr data-pid="${p.id}">
            <td><input class="editcell" data-p="producto" data-fid="${f.id}" data-pid="${p.id}" value="${esc(p.producto)}" ${disabledAttr}></td>
            <td class="num"><input class="editcell" style="text-align:right" data-p="cantidad" data-fid="${f.id}" data-pid="${p.id}" type="number" value="${p.cantidad}" ${disabledAttr}></td>
            <td class="num"><input class="editcell" style="text-align:right" data-p="valorNeto" data-fid="${f.id}" data-pid="${p.id}" type="number" value="${p.valorNeto}" ${disabledAttr}></td>
            <td class="num mono">${fmt(p.valorTotal || p.valorNeto*p.cantidad)}</td>
            ${!locked?`<td><button class="icon-btn" data-action="del-producto" data-fid="${f.id}" data-pid="${p.id}">✕</button></td>`:''}
          </tr>`).join('')}
      </tbody>
    </table>

    <div class="divider"></div>
    <div class="grid cols-4">
      <div class="field">
        <label>Forma de pago</label>
        <select class="editcell" data-f="formaPago" ${disabledAttr}>
          <option value="">Seleccionar...</option>
          ${FORMAS_PAGO.map(fp=>`<option value="${fp.v}" ${f.formaPago===fp.v?'selected':''}>${fp.l}</option>`).join('')}
          <option value="reenvio" ${f.formaPago==='reenvio'?'selected':''}>Reenvío</option>
        </select>
      </div>
      <div class="field"><label>Saldo a favor cliente</label><input type="number" class="editcell" data-f="saldoFavor" value="${f.saldoFavor||0}" ${disabledAttr}></div>
      <div class="field"><label>Retenciones</label><input type="number" class="editcell" data-f="retenciones" value="${f.retenciones||0}" ${disabledAttr}></div>
      <div class="field">
        <label>Estado de entrega</label>
        <select class="editcell" data-f="estado" data-fid="${f.id}" id="estadoSel-${f.id}" ${disabledAttr}>
          <option value="pendiente" ${f.estado==='pendiente'?'selected':''}>Pendiente</option>
          <option value="ok" ${f.estado==='ok'?'selected':''}>✅ OK — entregada sin novedad</option>
          <option value="dev_parcial" ${f.estado==='dev_parcial'?'selected':''}>🟡 Novedad / Devolución parcial</option>
          <option value="dev_total" ${f.estado==='dev_total'?'selected':''}>🔴 Devolución total</option>
        </select>
      </div>
    </div>
    <div class="section-note" id="pago-total-view">Total factura tras descuentos: <strong class="mono">${fmt(facturaTotalFinal(f))}</strong></div>

    <div id="novedad-block-${f.id}" class="${(f.estado==='dev_parcial'||f.estado==='dev_total')?'':'hidden'}">
      <div class="divider"></div>
      <div class="grid cols-2">
        <div class="field">
          <label>Causal de devolución</label>
          <select class="editcell" data-f="causal" ${disabledAttr}>
            <option value="">Seleccionar causal...</option>
            ${CAUSALES.map(c=>`<option value="${esc(c)}" ${f.causal===c?'selected':''}>${c}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Vendedor / Asesor comercial</label>
          <select class="editcell" data-f="vendedor" id="vendSel-${f.id}" ${disabledAttr}>
            <option value="">Seleccionar vendedor...</option>
            ${vendedores.map(v=>`<option value="${esc(v)}" ${f.vendedor===v?'selected':''}>${esc(v)}</option>`).join('')}
            <option value="__nuevo__">+ Agregar nuevo vendedor...</option>
          </select>
        </div>
      </div>

      ${f.estado==='dev_parcial' ? `
      <div class="divider"></div>
      <label>Selecciona el(los) producto(s) con novedad y cantidad a devolver</label>
      <div style="border:1px solid var(--line-soft); border-radius:8px; padding:6px 12px; margin-top:6px;">
        ${f.productos.map(p=>`
          <div class="chk-row">
            <input type="checkbox" data-devchk data-fid="${f.id}" data-pid="${p.id}" ${p.devuelta?'checked':''} ${disabledAttr}>
            <span style="flex:1">${esc(p.producto)} <span class="section-note" style="display:inline">(disp: ${p.cantidad})</span></span>
            <input type="number" data-devqty data-fid="${f.id}" data-pid="${p.id}" min="0" max="${p.cantidad}" value="${p.cantidadDevuelta||0}" style="width:80px" ${disabledAttr}>
          </div>`).join('')}
      </div>` : `<p class="section-note">Devolución total: se descuenta el 100% del valor de la factura.</p>`}

      <div class="divider"></div>
      <label>Firma digital del cliente</label>
      <div class="sigpad-wrap">
        <canvas class="sigpad" id="sig-${f.id}"></canvas>
        ${!locked?`<div class="sigpad-actions"><button class="btn btn-ghost btn-sm" data-action="clear-sig" data-fid="${f.id}">Borrar firma</button></div>`:''}
      </div>
    </div>

    <div class="divider"></div>
    <div class="flexrow between">
      <div class="section-note">Vlr. original: ${fmt(f.productos.reduce((s,p)=>s+(p.valorTotal||p.valorNeto*p.cantidad),0) || f.valorTotalFactura)}</div>
      ${!locked
        ? `<button class="btn btn-primary" data-action="confirmar-entrega" data-fid="${f.id}">✔️ Confirmar entrega</button>`
        : `<button class="btn btn-outline" data-action="editar-entrega" data-fid="${f.id}">✏️ Editar de nuevo</button>`}
    </div>
  `;
}

/* ============================================================================
   SECCIÓN 2 · DEVOLUCIÓN (formato F-GL-001)
   ============================================================================ */
let devEditMode = false;

function renderDevoluciones(){
  const r = state.ruta;
  return `
  <div class="topbar">
    <div><h2>Formato de devolución de pedidos</h2><p>Se registran automáticamente al confirmar una entrega con novedad o devolución.</p></div>
    <div class="flexrow">
      <button class="btn btn-outline" id="btnToggleEditDev">${devEditMode?'🔒 Bloquear plantilla':'✏️ Editar plantilla'}</button>
      <button class="btn btn-amber" id="btnAddDevRow">+ Fila manual</button>
      <button class="btn btn-primary" id="btnGenPdfDev">📄 Confirmar y generar PDF</button>
    </div>
  </div>

  <div class="card" id="devTemplate">
    <div class="print-header">
      <h4>LICONSUMAR DEL MAGDALENA — FORMATO DEVOLUCIÓN DE PEDIDOS</h4>
      <small>CÓDIGO F-GL-001</small>
    </div>

    <div class="causales-grid">
      ${CAUSALES.map(c=>`<div>${esc(c)}</div>`).join('')}
    </div>

    <div class="grid cols-2" style="margin:14px 0;">
      <div class="field"><label>Fecha</label><input type="date" id="devFecha" value="${esc(r.fecha)}"></div>
      <div class="field"><label>Placa</label><input type="text" id="devPlaca" value="${esc(r.placa)}"></div>
    </div>

    <table class="gridtable">
      <thead><tr>
        <th>Cliente</th><th>Factura</th><th>Asesor comercial</th><th>Causal</th>
        <th>Código producto</th><th>Descripción</th><th class="num">Cant. botellas</th><th>Firma cliente</th><th></th>
      </tr></thead>
      <tbody>
        ${state.devoluciones.map(d=>`
          <tr data-did="${d.id}">
            <td class="editable-cell" contenteditable="${devEditMode}" data-d="cliente">${esc(d.cliente)}</td>
            <td class="editable-cell" contenteditable="${devEditMode}" data-d="factura">${esc(d.factura)}</td>
            <td class="editable-cell" contenteditable="${devEditMode}" data-d="asesor">${esc(d.asesor)}</td>
            <td class="editable-cell" contenteditable="${devEditMode}" data-d="causal">${esc(d.causal)}</td>
            <td class="editable-cell" contenteditable="${devEditMode}" data-d="codigoProducto">${esc(d.codigoProducto)}</td>
            <td class="editable-cell" contenteditable="${devEditMode}" data-d="descripcion">${esc(d.descripcion)}</td>
            <td class="num editable-cell" contenteditable="${devEditMode}" data-d="cantidad">${esc(d.cantidad)}</td>
            <td>${d.firma ? `<img src="${d.firma}" style="height:34px">` : '<span class="section-note">—</span>'}</td>
            <td><button class="icon-btn" data-action="del-devolucion" data-did="${d.id}">✕</button></td>
          </tr>`).join('')}
        ${state.devoluciones.length===0 ? `<tr><td colspan="9" style="text-align:center;color:var(--muted)">Sin devoluciones registradas todavía</td></tr>` : ''}
      </tbody>
    </table>

    <div class="grid cols-2" style="margin-top:24px;">
      <div style="text-align:center; border-top:1px solid var(--line); padding-top:6px; font-size:11.5px;">FIRMA RESPONSABLE DE RECIBO</div>
      <div style="text-align:center; border-top:1px solid var(--line); padding-top:6px; font-size:11.5px;">FIRMA DE QUIEN ENTREGA</div>
    </div>
  </div>
  `;
}

/* ============================================================================
   SECCIÓN 3 · CUADRE DE RUTA
   ============================================================================ */
function cuadreTotales(){
  const f = state.facturas;
  const by = (pred) => f.filter(pred);
  const sum = (arr, val) => arr.reduce((s,x)=> s + val(x), 0);

  const devTotales   = by(x=>x.estado==='dev_total');
  const devParciales = by(x=>x.estado==='dev_parcial');
  const credito       = by(x=>x.formaPago==='credito');
  const retenciones    = by(x=>num(x.retenciones)>0);
  const saldoFavor      = by(x=>num(x.saldoFavor)>0);
  const transferencia    = by(x=>x.formaPago==='transferencia');
  const mixtaTransf       = by(x=>x.formaPago==='mixta_transferencia');
  const mixtaEfectivo      = by(x=>x.formaPago==='mixta_efectivo');
  const efectivo             = by(x=>x.formaPago==='efectivo');
  const reenvios = state.reenvios;

  const rows = [
    { label:'Dev. totales',    cta: devTotales.length,   valor: sum(devTotales, x=>num(x.valorTotalFactura)) },
    { label:'Dev. parciales',  cta: devParciales.length, valor: sum(devParciales, x=> num(x.valorTotalFactura) - facturaTotalFinal(x)) },
    { label:'Reenvío',         cta: reenvios.length,     valor: sum(reenvios, x=>num(x.totalFactura)) },
    { label:'Crédito',         cta: credito.length,      valor: sum(credito, x=>facturaTotalFinal(x)) },
    { label:'Retenciones',     cta: retenciones.length,  valor: sum(retenciones, x=>num(x.retenciones)) },
    { label:'Saldo a Favor',   cta: saldoFavor.length,   valor: sum(saldoFavor, x=>num(x.saldoFavor)) },
    { label:'Transferencia',   cta: transferencia.length,valor: sum(transferencia, x=>facturaTotalFinal(x)) },
    { label:'Mixta. Transf',   cta: mixtaTransf.length,  valor: sum(mixtaTransf, x=>facturaTotalFinal(x)) },
    { label:'Mixta. Efectivo', cta: mixtaEfectivo.length,valor: sum(mixtaEfectivo, x=>facturaTotalFinal(x)) },
    { label:'Efectivo',        cta: efectivo.length,     valor: sum(efectivo, x=>facturaTotalFinal(x)) },
  ];
  const totalEfectivo = sum(efectivo, x=>facturaTotalFinal(x)) + sum(mixtaEfectivo, x=>facturaTotalFinal(x));
  const totalALegalizar = totalEfectivo + sum(transferencia, x=>facturaTotalFinal(x)) + sum(mixtaTransf, x=>facturaTotalFinal(x));
  const sumaFacturas = state.facturas.reduce((s,x)=> s + num(x.valorTotalFactura), 0);
  return { rows, totalEfectivo, totalALegalizar, sumaFacturas };
}

function renderCuadre(){
  const r = state.ruta;
  const c = cuadreTotales();
  const coincide = Math.abs(c.sumaFacturas - num(r.valorTotalPlanilla)) < 1;

  return `
  <div class="topbar">
    <div><h2>Cuadre de ruta</h2><p>Consolidado automático de la planilla, según los datos registrados en Entregas.</p></div>
    <button class="btn btn-primary" id="btnGenPdfCuadre">📄 Descargar cuadre en PDF</button>
  </div>

  <div class="card" id="cuadreTemplate">
    <div class="print-header">
      <h4>LICONSUMAR DEL MAGDALENA</h4>
      <small>CUADRE DE RUTA</small>
    </div>

    <table class="gridtable" style="margin-top:10px;">
      <tbody>
        <tr><td style="width:25%"><strong>Fecha:</strong></td><td>${esc(r.fecha)}</td><td style="width:25%"><strong>Planilla:</strong></td><td>${esc(r.numeroPlanilla)}</td></tr>
        <tr><td><strong>Vehículo:</strong></td><td>${esc(r.placa)}</td><td><strong>Entregador:</strong></td><td>${esc(r.entregador)}</td></tr>
        <tr><td><strong>Valor Total Planilla</strong></td><td class="num mono">${fmt(r.valorTotalPlanilla)}</td><td><strong>Cta. Total Facturas</strong></td><td class="num mono">${state.facturas.length}</td></tr>
      </tbody>
    </table>

    <div class="section-note" style="margin-top:8px;">
      Suma de facturas registradas en Entregas: <strong class="mono">${fmt(c.sumaFacturas)}</strong>
      ${coincide
        ? `<span class="badge badge-ok" style="margin-left:8px;">✓ Coincide con la planilla</span>`
        : `<span class="badge badge-warn" style="margin-left:8px;">⚠ Diferencia de ${fmt(Math.abs(c.sumaFacturas-num(r.valorTotalPlanilla)))}</span>`}
    </div>

    <table class="gridtable" style="margin-top:14px;">
      <thead><tr><th>Concepto</th><th class="num">Cta. facturas</th><th class="num">Valor</th></tr></thead>
      <tbody>
        ${c.rows.map(row=>`<tr><td>${row.label}</td><td class="num mono">${row.cta}</td><td class="num mono">${fmt(row.valor)}</td></tr>`).join('')}
        <tr style="background:#f7f2e5;"><td><strong>Total Efectivo</strong></td><td></td><td class="num mono"><strong>${fmt(c.totalEfectivo)}</strong></td></tr>
        <tr style="background:var(--navy); color:#fff;"><td><strong>Total a Legalizar</strong></td><td></td><td class="num mono"><strong>${fmt(c.totalALegalizar)}</strong></td></tr>
      </tbody>
    </table>

    <div class="grid cols-2" style="margin-top:14px;">
      <div class="field"><label>NOTA</label><textarea id="cuadreNota" rows="2" placeholder="Observaciones de la ruta..."></textarea></div>
      <div class="field"><label>Dinero entregado en caja</label><input type="number" id="dineroCaja" value="${r.dineroEntregadoCaja||0}"></div>
    </div>

    <div class="grid cols-2" style="margin-top:24px;">
      <div style="text-align:center; border-top:1px solid var(--line); padding-top:6px; font-size:11.5px;">RECIBIDO LOGÍSTICA</div>
      <div style="text-align:center; border-top:1px solid var(--line); padding-top:6px; font-size:11.5px;">RECIBIDO CAJA</div>
    </div>
  </div>
  `;
}

/* ============================================================================
   SECCIÓN 4 · FACTURAS REENVÍO
   ============================================================================ */
function renderReenvios(){
  const totalReenvio = state.reenvios.reduce((s,x)=>s+num(x.totalFactura),0);
  return `
  <div class="topbar">
    <div><h2>Facturas de reenvío</h2><p>Registro manual. No se suman al cuadre de ruta principal — llevan su propio consolidado.</p></div>
    <button class="btn btn-amber" id="btnAddReenvio">+ Agregar factura de reenvío</button>
  </div>
  <div class="card">
    <table class="gridtable">
      <thead><tr><th>N° Factura</th><th class="num">Total factura</th><th></th></tr></thead>
      <tbody>
        ${state.reenvios.map(rv=>`
          <tr data-rid="${rv.id}">
            <td><input class="editcell" data-r="numeroFactura" data-rid="${rv.id}" value="${esc(rv.numeroFactura)}"></td>
            <td class="num"><input class="editcell" style="text-align:right" data-r="totalFactura" data-rid="${rv.id}" type="number" value="${rv.totalFactura||0}"></td>
            <td><button class="icon-btn" data-action="del-reenvio" data-rid="${rv.id}">✕</button></td>
          </tr>`).join('')}
        ${state.reenvios.length===0 ? `<tr><td colspan="3" style="text-align:center;color:var(--muted)">Sin facturas de reenvío</td></tr>` : ''}
      </tbody>
      <tfoot><tr style="background:#f7f2e5;"><td><strong>Consolidado reenvío</strong></td><td class="num mono"><strong>${fmt(totalReenvio)}</strong></td><td></td></tr></tfoot>
    </table>
  </div>
  `;
}

/* ============================================================================
   SECCIÓN 5 · BASE DE DATOS DE CLIENTES
   ============================================================================ */
function renderClientes(){
  return `
  <div class="topbar">
    <div><h2>Base de datos de clientes</h2><p>Crea y consulta la ficha de cada cliente de la ruta.</p></div>
  </div>

  <div class="card">
    <h3><span class="tag">+</span> Nuevo cliente</h3>
    <div class="grid cols-3">
      <div class="field"><label>Nombre del cliente</label><input type="text" id="cliNombre"></div>
      <div class="field"><label>Nombre del negocio</label><input type="text" id="cliNegocio"></div>
      <div class="field"><label>Teléfono</label><input type="tel" id="cliTelefono"></div>
      <div class="field"><label>Dirección</label><input type="text" id="cliDireccion"></div>
      <div class="field"><label>Horario de atención</label><input type="text" id="cliHorario" placeholder="Ej: 8am - 12m / 2pm - 6pm"></div>
      <div class="field">
        <label>Vendedor</label>
        <select id="cliVendedor">
          <option value="">Seleccionar...</option>
          ${state.vendedores.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div style="margin-top:12px;"><button class="btn btn-primary" id="btnAddCliente">+ Guardar cliente</button></div>
  </div>

  <div class="card">
    <h3>Clientes registrados (${state.clientes.length})</h3>
    <table class="gridtable">
      <thead><tr><th>Cliente</th><th>Negocio</th><th>Teléfono</th><th>Dirección</th><th>Horario</th><th>Vendedor</th><th>Acciones</th></tr></thead>
      <tbody>
        ${state.clientes.map(c=>`
          <tr data-cid="${c.id}">
            <td>${esc(c.nombre)}</td><td>${esc(c.negocio)}</td><td>${esc(c.telefono)}</td>
            <td>${esc(c.direccion)}</td><td>${esc(c.horario)}</td><td>${esc(c.vendedor)}</td>
            <td class="flexrow">
              <button class="btn btn-outline btn-sm" data-action="cli-jpg" data-cid="${c.id}">JPG</button>
              <button class="btn btn-outline btn-sm" data-action="cli-pdf" data-cid="${c.id}">PDF</button>
              <button class="btn btn-outline btn-sm" data-action="cli-share" data-cid="${c.id}">Compartir</button>
              <button class="icon-btn" data-action="del-cliente" data-cid="${c.id}">✕</button>
            </td>
          </tr>`).join('')}
        ${state.clientes.length===0 ? `<tr><td colspan="7" style="text-align:center;color:var(--muted)">Aún no hay clientes registrados</td></tr>` : ''}
      </tbody>
    </table>
  </div>

  <div id="cliThumbHost" style="position:fixed; left:-9999px; top:0;"></div>
  `;
}

/* ============================================================================
   FIRMA DIGITAL (canvas)
   ============================================================================ */
function initSignaturePad(canvas, existingDataUrl){
  const ctx = canvas.getContext('2d');
  function resize(){
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const prev = canvas.toDataURL ? canvas.toDataURL() : null;
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '#16233d';
    if(existingDataUrl){
      const img = new Image();
      img.onload = ()=> ctx.drawImage(img, 0, 0, rect.width, rect.height);
      img.src = existingDataUrl;
    }
  }
  resize();
  let drawing = false, last = null;
  function pos(e){
    const rect = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  }
  function start(e){ drawing = true; last = pos(e); e.preventDefault(); }
  function move(e){
    if(!drawing) return;
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last = p; e.preventDefault();
  }
  function end(){ drawing = false; }
  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start, {passive:false});
  canvas.addEventListener('touchmove', move, {passive:false});
  canvas.addEventListener('touchend', end);
  canvas._clear = () => { ctx.clearRect(0,0,canvas.width,canvas.height); };
}

function initAllSignaturePads(){
  document.querySelectorAll('canvas.sigpad').forEach(c=>{
    const fid = c.id.replace('sig-','');
    const f = state.facturas.find(x=>x.id===fid);
    initSignaturePad(c, f && f.firma);
  });
}

/* ============================================================================
   PARSEO DE EXCEL "entregas productos"
   ============================================================================ */
function handleExcelFile(file){
  const reader = new FileReader();
  reader.onload = (e) => {
    try{
      const wb = XLSX.read(e.target.result, { type:'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header:1, defval:'' });

      // localizar fila de encabezados (contiene "Factura")
      let headerIdx = rows.findIndex(r => r.some(c => String(c).toLowerCase().includes('factura')));
      if(headerIdx === -1) headerIdx = 0;
      const headers = rows[headerIdx].map(h=>String(h).toLowerCase().trim());
      const idx = {
        factura: headers.findIndex(h=>h.includes('factura')),
        producto: headers.findIndex(h=>h.includes('producto')),
        cantidad: headers.findIndex(h=>h.includes('cantidad')),
        barrio: headers.findIndex(h=>h.includes('barrio')),
        direccion: headers.findIndex(h=>h.includes('direcc')),
        ciudad: headers.findIndex(h=>h.includes('ciudad')),
        valorNeto: headers.findIndex(h=>h.includes('valor neto')),
        valorTotalFactura: headers.findIndex(h=>h.includes('valor total factura')),
      };

      const nuevasFacturas = [];
      let current = null;
      for(let i=headerIdx+1; i<rows.length; i++){
        const row = rows[i];
        if(!row || row.every(c=>c==='' || c==null)) continue;
        const facturaVal = idx.factura>=0 ? String(row[idx.factura]||'').trim() : '';
        const producto = idx.producto>=0 ? String(row[idx.producto]||'').trim() : '';
        if(!producto) continue;

        if(facturaVal){
          current = {
            id: uid(), factura: facturaVal,
            barrio: idx.barrio>=0 ? row[idx.barrio] : '',
            direccion: idx.direccion>=0 ? row[idx.direccion] : '',
            ciudad: idx.ciudad>=0 ? row[idx.ciudad] : 'Santa Marta',
            valorTotalFactura: idx.valorTotalFactura>=0 ? num(row[idx.valorTotalFactura]) : 0,
            productos: [], estado:'pendiente', formaPago:'', saldoFavor:0, retenciones:0,
            vendedor:'', causal:'', firma:null, confirmado:false
          };
          nuevasFacturas.push(current);
        }
        if(!current) continue;
        const cantidad = idx.cantidad>=0 ? num(row[idx.cantidad]) : 0;
        const valorNeto = idx.valorNeto>=0 ? num(row[idx.valorNeto]) : 0;
        current.productos.push({
          id: uid(), producto, cantidad, valorNeto,
          valorTotal: valorNeto, // el "valor neto" en la planilla ya es el valor de línea
          devuelta:false, cantidadDevuelta:0
        });
      }

      if(nuevasFacturas.length===0){
        toast('⚠️ No se encontraron filas de productos en el archivo.', 'err');
        return;
      }
      state.facturas = state.facturas.concat(nuevasFacturas);
      state.ruta.ctaTotalFacturas = state.facturas.length;
      saveState();
      toast(`✅ Se cargaron ${nuevasFacturas.length} facturas desde el Excel.`, 'ok');
      render();
    }catch(err){
      console.error(err);
      toast('⚠️ No se pudo leer el archivo. Verifica el formato.', 'err');
    }
  };
  reader.readAsArrayBuffer(file);
}

/* ============================================================================
   EXPORTAR JPG / PDF
   ============================================================================ */
async function exportNodeAsImage(node, filename){
  const canvas = await html2canvas(node, { backgroundColor:'#ffffff', scale:2 });
  return new Promise(resolve=>{
    canvas.toBlob(blob=>{
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      resolve({ blob, url });
    }, 'image/jpeg', 0.95);
  });
}

async function exportNodeAsPdfLetter(node, filename){
  const canvas = await html2canvas(node, { backgroundColor:'#ffffff', scale:2 });
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit:'pt', format:'letter' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const imgW = pageW - 40;
  const imgH = canvas.height * (imgW / canvas.width);
  let heightLeft = imgH, position = 20;
  const imgData = canvas.toDataURL('image/jpeg', 0.95);
  pdf.addImage(imgData, 'JPEG', 20, position, imgW, imgH);
  heightLeft -= (pageH - 40);
  while(heightLeft > 0){
    position = heightLeft - imgH + 20;
    pdf.addPage();
    pdf.addImage(imgData, 'JPEG', 20, position, imgW, imgH);
    heightLeft -= (pageH - 40);
  }
  pdf.save(filename);
}

function buildClientThumb(c){
  return `
  <div class="client-thumb">
    <div class="print-header"><h4>FICHA DE CLIENTE</h4><small>LICONSUMAR Del Magdalena</small></div>
    <table class="gridtable" style="margin-top:10px;">
      <tbody>
        <tr><td><strong>Cliente</strong></td><td>${esc(c.nombre)}</td></tr>
        <tr><td><strong>Negocio</strong></td><td>${esc(c.negocio)}</td></tr>
        <tr><td><strong>Teléfono</strong></td><td>${esc(c.telefono)}</td></tr>
        <tr><td><strong>Dirección</strong></td><td>${esc(c.direccion)}</td></tr>
        <tr><td><strong>Horario</strong></td><td>${esc(c.horario)}</td></tr>
        <tr><td><strong>Vendedor</strong></td><td>${esc(c.vendedor)}</td></tr>
      </tbody>
    </table>
  </div>`;
}

/* ============================================================================
   MANEJADORES DE EVENTOS (delegación)
   ============================================================================ */
function wireGlobalHandlers(){
  initAllSignaturePads();

  // ---- Datos de ruta (sección 1) ----
  bindInput('rEntregador', v=> state.ruta.entregador = v);
  bindInput('rPlaca', v=> state.ruta.placa = v);
  bindInput('rFecha', v=> state.ruta.fecha = v);
  bindInput('rPlanilla', v=> state.ruta.numeroPlanilla = v);
  bindInput('rValorTotal', v=> state.ruta.valorTotalPlanilla = num(v));
  bindInput('rCtaTotal', v=> state.ruta.ctaTotalFacturas = num(v));

  const fileInput = document.getElementById('fileInput');
  const uploadBox = document.getElementById('uploadBox');
  if(fileInput){
    fileInput.addEventListener('change', e=>{ if(e.target.files[0]) handleExcelFile(e.target.files[0]); });
    uploadBox.addEventListener('click', ()=> fileInput.click());
    uploadBox.addEventListener('dragover', e=>{ e.preventDefault(); });
    uploadBox.addEventListener('drop', e=>{ e.preventDefault(); if(e.dataTransfer.files[0]) handleExcelFile(e.dataTransfer.files[0]); });
  }

  bindInput('fSearch', v=>{ entregasFilter.q=v; render(); }, 'input');
  bindSelect('fEstadoFilter', v=>{ entregasFilter.estado=v; render(); });
  bindSelect('fGroupBy', v=>{ entregasFilter.groupBy=v; render(); });
  onClick('btnAddFactura', ()=>{
    const f = { id:uid(), factura:'', barrio:'', direccion:'', ciudad:'Santa Marta', valorTotalFactura:0,
      productos:[{id:uid(), producto:'', cantidad:1, valorNeto:0, valorTotal:0, devuelta:false, cantidadDevuelta:0}],
      estado:'pendiente', formaPago:'', saldoFavor:0, retenciones:0, vendedor:'', causal:'', firma:null, confirmado:false };
    state.facturas.unshift(f); openCards.add(f.id); saveState(); render();
  });

  // toggle abrir/cerrar factura
  document.querySelectorAll('[data-toggle]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const id = el.dataset.toggle;
      if(openCards.has(id)) openCards.delete(id); else openCards.add(id);
      render();
    });
  });

  // editcell genéricos de factura (data-f) y producto (data-p)
  document.querySelectorAll('.editcell[data-f]').forEach(el=>{
    const evt = (el.tagName==='SELECT') ? 'change' : 'change';
    el.addEventListener(evt, ()=>{
      const card = el.closest('.factura-card');
      if(!card) return;
      const fid = card.dataset.fid;
      const f = state.facturas.find(x=>x.id===fid);
      if(!f) return;
      const key = el.dataset.f;
      if(key==='vendedor' && el.value==='__nuevo__'){
        const nombre = prompt('Nombre del nuevo vendedor:');
        if(nombre){ state.vendedores.push(nombre); f.vendedor = nombre; }
        else { el.value = f.vendedor || ''; }
      } else {
        f[key] = (el.type==='number') ? num(el.value) : el.value;
      }
      saveState();
      render();
    });
  });
  document.querySelectorAll('.editcell[data-p]').forEach(el=>{
    el.addEventListener('change', ()=>{
      const fid = el.dataset.fid, pid = el.dataset.pid;
      const f = state.facturas.find(x=>x.id===fid); if(!f) return;
      const p = f.productos.find(x=>x.id===pid); if(!p) return;
      const key = el.dataset.p;
      p[key] = (el.type==='number') ? num(el.value) : el.value;
      if(key==='cantidad' || key==='valorNeto') p.valorTotal = num(p.cantidad) * num(p.valorNeto);
      saveState(); render();
    });
  });

  document.querySelectorAll('[data-action="add-producto"]').forEach(b=> b.addEventListener('click', ()=>{
    const f = state.facturas.find(x=>x.id===b.dataset.fid); if(!f) return;
    f.productos.push({ id:uid(), producto:'', cantidad:1, valorNeto:0, valorTotal:0, devuelta:false, cantidadDevuelta:0 });
    saveState(); render();
  }));
  document.querySelectorAll('[data-action="del-producto"]').forEach(b=> b.addEventListener('click', ()=>{
    const f = state.facturas.find(x=>x.id===b.dataset.fid); if(!f) return;
    f.productos = f.productos.filter(p=>p.id!==b.dataset.pid);
    saveState(); render();
  }));
  document.querySelectorAll('[data-action="del-factura"]').forEach(b=> b.addEventListener('click', (e)=>{
    e.stopPropagation();
    if(!confirm('¿Eliminar esta factura de la ruta?')) return;
    state.facturas = state.facturas.filter(x=>x.id!==b.dataset.fid);
    saveState(); render();
  }));

  document.querySelectorAll('[data-action="toggle-map"]').forEach(b=> b.addEventListener('click', ()=>{
    const fid = b.dataset.fid;
    const f = state.facturas.find(x=>x.id===fid); if(!f) return;
    const host = document.getElementById('mapwrap-'+fid);
    if(host.innerHTML){ host.innerHTML=''; return; }
    host.innerHTML = `<iframe class="map-frame" src="${mapEmbedUrl(f.direccion, f.barrio, f.ciudad)}" loading="lazy"></iframe>`;
  }));

  document.querySelectorAll('[data-devchk]').forEach(chk=> chk.addEventListener('change', ()=>{
    const f = state.facturas.find(x=>x.id===chk.dataset.fid); if(!f) return;
    const p = f.productos.find(x=>x.id===chk.dataset.pid); if(!p) return;
    p.devuelta = chk.checked;
    if(!chk.checked) p.cantidadDevuelta = 0;
    saveState(); render();
  }));
  document.querySelectorAll('[data-devqty]').forEach(inp=> inp.addEventListener('change', ()=>{
    const f = state.facturas.find(x=>x.id===inp.dataset.fid); if(!f) return;
    const p = f.productos.find(x=>x.id===inp.dataset.pid); if(!p) return;
    p.cantidadDevuelta = Math.min(num(inp.value), num(p.cantidad));
    if(p.cantidadDevuelta>0) p.devuelta = true;
    saveState(); render();
  }));

  document.querySelectorAll('[data-action="clear-sig"]').forEach(b=> b.addEventListener('click', ()=>{
    const c = document.getElementById('sig-'+b.dataset.fid);
    if(c && c._clear) c._clear();
  }));

  document.querySelectorAll('[data-action="confirmar-entrega"]').forEach(b=> b.addEventListener('click', ()=> confirmarEntrega(b.dataset.fid)));
  document.querySelectorAll('[data-action="editar-entrega"]').forEach(b=> b.addEventListener('click', ()=>{
    const f = state.facturas.find(x=>x.id===b.dataset.fid); if(!f) return;
    f.confirmado = false; saveState(); render();
  }));

  document.querySelectorAll('[data-action="share-jpg"]').forEach(b=> b.addEventListener('click', async (e)=>{
    e.stopPropagation();
    const fid = b.dataset.fid;
    if(!openCards.has(fid)){ openCards.add(fid); render(); }
    setTimeout(async ()=>{
      const card = document.querySelector(`.factura-card[data-fid="${fid}"]`);
      const { blob, url } = await exportNodeAsImage(card, `factura-${fid}.jpg`);
      if(navigator.share){
        try{ await navigator.share({ files:[new File([blob], `factura.jpg`, {type:'image/jpeg'})], title:'Factura entrega' }); }catch(_){}
      }
      toast('🖼️ Imagen de la factura descargada.');
    }, 150);
  }));

  // ---- Sección 2: Devoluciones ----
  onClick('btnToggleEditDev', ()=>{ devEditMode = !devEditMode; render(); });
  onClick('btnAddDevRow', ()=>{
    state.devoluciones.unshift({ id:uid(), fecha: state.ruta.fecha, placa: state.ruta.placa, cliente:'', factura:'', asesor:'', causal:'', codigoProducto:'', descripcion:'', cantidad:0, firma:null });
    saveState(); render();
  });
  document.querySelectorAll('.editable-cell[data-d]').forEach(el=> el.addEventListener('blur', ()=>{
    const row = el.closest('tr'); const d = state.devoluciones.find(x=>x.id===row.dataset.did); if(!d) return;
    d[el.dataset.d] = el.innerText.trim();
    saveState();
  }));
  document.querySelectorAll('[data-action="del-devolucion"]').forEach(b=> b.addEventListener('click', ()=>{
    state.devoluciones = state.devoluciones.filter(x=>x.id!==b.dataset.did); saveState(); render();
  }));
  onClick('btnGenPdfDev', async ()=>{
    const node = document.getElementById('devTemplate');
    await exportNodeAsPdfLetter(node, `devolucion-${state.ruta.numeroPlanilla||'ruta'}.pdf`);
    toast('📄 PDF de devolución generado.');
  });

  // ---- Sección 3: Cuadre ----
  bindInput('dineroCaja', v=>{ state.ruta.dineroEntregadoCaja = num(v); saveState(); });
  onClick('btnGenPdfCuadre', async ()=>{
    const node = document.getElementById('cuadreTemplate');
    await exportNodeAsPdfLetter(node, `cuadre-ruta-${state.ruta.numeroPlanilla||'ruta'}.pdf`);
    toast('📄 PDF del cuadre generado.');
  });

  // ---- Sección 4: Reenvíos ----
  onClick('btnAddReenvio', ()=>{ state.reenvios.unshift({ id:uid(), numeroFactura:'', totalFactura:0 }); saveState(); render(); });
  document.querySelectorAll('.editcell[data-r]').forEach(el=> el.addEventListener('change', ()=>{
    const rv = state.reenvios.find(x=>x.id===el.dataset.rid); if(!rv) return;
    rv[el.dataset.r] = (el.type==='number') ? num(el.value) : el.value;
    saveState(); render();
  }));
  document.querySelectorAll('[data-action="del-reenvio"]').forEach(b=> b.addEventListener('click', ()=>{
    state.reenvios = state.reenvios.filter(x=>x.id!==b.dataset.rid); saveState(); render();
  }));

  // ---- Sección 5: Clientes ----
  onClick('btnAddCliente', ()=>{
    const nombre = document.getElementById('cliNombre').value.trim();
    if(!nombre){ toast('⚠️ Ingresa el nombre del cliente.', 'err'); return; }
    const c = {
      id: uid(), nombre, negocio: document.getElementById('cliNegocio').value.trim(),
      telefono: document.getElementById('cliTelefono').value.trim(),
      direccion: document.getElementById('cliDireccion').value.trim(),
      horario: document.getElementById('cliHorario').value.trim(),
      vendedor: document.getElementById('cliVendedor').value
    };
    state.clientes.unshift(c); saveState(); render();
    guardarClienteEnSupabase(c);
    toast('✅ Cliente guardado.', 'ok');
  });
  document.querySelectorAll('[data-action="del-cliente"]').forEach(b=> b.addEventListener('click', ()=>{
    state.clientes = state.clientes.filter(x=>x.id!==b.dataset.cid); saveState(); render();
  }));
  document.querySelectorAll('[data-action="cli-jpg"],[data-action="cli-pdf"],[data-action="cli-share"]').forEach(b=> b.addEventListener('click', async ()=>{
    const c = state.clientes.find(x=>x.id===b.dataset.cid); if(!c) return;
    const host = document.getElementById('cliThumbHost');
    host.innerHTML = buildClientThumb(c);
    const node = host.firstElementChild;
    const action = b.dataset.action;
    if(action==='cli-jpg'){ await exportNodeAsImage(node, `cliente-${c.nombre}.jpg`); toast('🖼️ Ficha de cliente descargada.'); }
    else if(action==='cli-pdf'){ await exportNodeAsPdfLetter(node, `cliente-${c.nombre}.pdf`); toast('📄 PDF de cliente generado.'); }
    else if(action==='cli-share'){
      const { blob } = await exportNodeAsImage(node, `cliente-${c.nombre}.jpg`);
      if(navigator.share){
        try{ await navigator.share({ files:[new File([blob], 'cliente.jpg', {type:'image/jpeg'})], title:'Ficha de cliente' }); }catch(_){}
      } else toast('Imagen descargada — compártela manualmente.');
    }
  }));
}

function confirmarEntrega(fid){
  const f = state.facturas.find(x=>x.id===fid); if(!f) return;
  if(f.estado==='pendiente'){ toast('⚠️ Selecciona un estado de entrega antes de confirmar.', 'err'); return; }
  if((f.estado==='dev_parcial' || f.estado==='dev_total') && !f.causal){ toast('⚠️ Selecciona la causal de devolución.', 'err'); return; }

  const sigCanvas = document.getElementById('sig-'+fid);
  if(sigCanvas && (f.estado==='dev_parcial' || f.estado==='dev_total')){
    f.firma = sigCanvas.toDataURL('image/png');
  }

  // registrar en devoluciones
  if(f.estado==='dev_total'){
    state.devoluciones.unshift({
      id: uid(), fecha: state.ruta.fecha, placa: state.ruta.placa, cliente: f.barrio,
      factura: f.factura, asesor: f.vendedor, causal: f.causal || '12. Dev total factura',
      codigoProducto: '-', descripcion: '12. DEV TOTAL FACTURA', cantidad: f.productos.reduce((s,p)=>s+num(p.cantidad),0),
      firma: f.firma
    });
  } else if(f.estado==='dev_parcial'){
    f.productos.filter(p=>p.devuelta && num(p.cantidadDevuelta)>0).forEach(p=>{
      state.devoluciones.unshift({
        id: uid(), fecha: state.ruta.fecha, placa: state.ruta.placa, cliente: f.barrio,
        factura: f.factura, asesor: f.vendedor, causal: f.causal,
        codigoProducto: p.id.slice(0,6).toUpperCase(), descripcion: p.producto, cantidad: p.cantidadDevuelta,
        firma: f.firma
      });
    });
  }
  f.confirmado = true;
  saveState();
  toast('✅ Entrega confirmada.', 'ok');
  render();
}

/* ============================================================================
   HELPERS DE BINDING
   ============================================================================ */
function bindInput(id, fn, evt){
  const el = document.getElementById(id); if(!el) return;
  el.addEventListener(evt||'change', ()=>{ fn(el.value); saveState(); });
}
function bindSelect(id, fn){ bindInput(id, fn, 'change'); }
function onClick(id, fn){ const el = document.getElementById(id); if(el) el.addEventListener('click', fn); }

/* ============================================================================
   INIT
   ============================================================================ */
document.getElementById('navtabs').addEventListener('click', e=>{
  const btn = e.target.closest('button[data-tab]');
  if(btn) switchTab(btn.dataset.tab);
});
document.getElementById('btnMenu').addEventListener('click', ()=> document.getElementById('sidebar').classList.toggle('open'));
document.getElementById('btnSaveRoute').addEventListener('click', guardarRutaCompleta);
document.getElementById('btnClearAll').addEventListener('click', ()=> resetRuta(true));

render();
