import { el, clear, fmtMoney, fmtDate, fmtDateTime, badge, badgeAs, toast, openModal } from '../dom.js';
import { api, fileUrl } from '../api.js';

const COST_CATEGORIES = ['fuel', 'driver', 'toll', 'maintenance', 'mechanical_repair', 'other'];

function loadForm(drivers, trucks, onSubmit) {
  const driverSel = el('select', { required: true }, [
    el('option', { value: '' }, 'Select driver'),
    ...drivers.map((d) => el('option', { value: d.id }, d.name)),
  ]);
  const truckSel = el('select', {}, [
    el('option', { value: '' }, 'Unassigned'),
    ...trucks.map((t) => el('option', { value: t.id }, t.plate_no)),
  ]);
  const origin = el('input', { required: true, placeholder: 'e.g. Jinja' });
  const destination = el('input', { required: true, placeholder: 'e.g. Kampala' });
  const cargo = el('input', { placeholder: 'e.g. Sugar, 30 tonnes' });
  const rate = el('input', { type: 'number', step: '0.01', placeholder: 'UGX' });
  const dateInput = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
  const errorBox = el('div', { class: 'error-text' });

  const form = el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      errorBox.textContent = '';
      try {
        await onSubmit({
          driver_id: Number(driverSel.value),
          truck_id: truckSel.value ? Number(truckSel.value) : null,
          origin: origin.value, destination: destination.value, cargo: cargo.value || null,
          rate: rate.value ? Number(rate.value) : null,
          load_date: dateInput.value,
        });
      } catch (err) { errorBox.textContent = err.message; }
    },
  }, [
    el('h3', {}, 'New load'),
    el('div', { class: 'field' }, [el('label', {}, 'Driver'), driverSel]),
    el('div', { class: 'field' }, [el('label', {}, 'Truck'), truckSel]),
    el('div', { class: 'form-row' }, [
      el('div', { class: 'field' }, [el('label', {}, 'Origin'), origin]),
      el('div', { class: 'field' }, [el('label', {}, 'Destination'), destination]),
    ]),
    el('div', { class: 'field' }, [el('label', {}, 'Cargo'), cargo]),
    el('div', { class: 'form-row' }, [
      el('div', { class: 'field' }, [el('label', {}, 'Rate (UGX)'), rate]),
      el('div', { class: 'field' }, [el('label', {}, 'Date'), dateInput]),
    ]),
    errorBox,
    el('div', { class: 'modal-actions' }, [el('button', { class: 'btn btn-primary', type: 'submit' }, 'Create load')]),
  ]);
  return form;
}

async function renderLoadsTab(container) {
  clear(container);
  container.appendChild(el('p', { class: 'muted' }, 'Loading…'));
  const [loadsRes, driversRes, trucksRes] = await Promise.all([
    api.get('/api/fleet/loads'), api.get('/api/drivers'), api.get('/api/fleet/trucks'),
  ]);
  clear(container);

  const newBtn = el('button', {
    class: 'btn btn-accent btn-sm',
    onclick: () => {
      const form = loadForm(driversRes.drivers, trucksRes.trucks, async (payload) => {
        await api.post('/api/fleet/loads', payload);
        close();
        toast('Load created', 'success');
        renderLoadsTab(container);
      });
      const close = openModal(form);
    },
  }, '+ New load');

  container.appendChild(el('div', { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: '12px' } }, newBtn));

  const rows = loadsRes.loads.map((l) => el('tr', {}, [
    el('td', {}, fmtDate(l.load_date)),
    el('td', {}, l.driver_name || '—'),
    el('td', {}, l.plate_no || '—'),
    el('td', {}, `${l.origin} → ${l.destination}`),
    el('td', {}, l.cargo || '—'),
    el('td', { class: 'mono' }, l.rate ? fmtMoney(l.rate) : '—'),
    el('td', {}, l.self_sourced ? 'Driver' : 'Dispatch'),
    el('td', {}, badge(l.status)),
    el('td', {}, el('select', {
      value: l.status,
      onchange: async (e) => {
        await api.patch(`/api/fleet/loads/${l.id}`, { status: e.target.value });
        toast('Status updated', 'success');
      },
    }, ['assigned', 'in_transit', 'delivered', 'cancelled'].map((s) => el('option', { value: s, selected: s === l.status }, s)))),
  ]));

  container.appendChild(el('div', { class: 'card' }, el('div', { class: 'table-wrap' }, el('table', {}, [
    el('thead', {}, el('tr', {}, ['Date', 'Driver', 'Truck', 'Route', 'Cargo', 'Rate', 'Source', 'Status', ''].map((h) => el('th', {}, h)))),
    el('tbody', {}, rows.length ? rows : el('tr', { class: 'empty-row' }, el('td', { colspan: 9 }, 'No loads yet.'))),
  ]))));
}

async function renderIssuesTab(container) {
  clear(container);
  container.appendChild(el('p', { class: 'muted' }, 'Loading…'));
  const [{ issues }, { documents }] = await Promise.all([
    api.get('/api/fleet/issues'),
    api.get('/api/documents?ref_table=fleet_issues'),
  ]);
  clear(container);
  const photoByIssue = {};
  documents.forEach((d) => { photoByIssue[d.ref_id] = d; });
  const rows = issues.map((i) => el('tr', {}, [
    el('td', {}, fmtDateTime(i.created_at)),
    el('td', {}, i.driver_name || '—'),
    el('td', {}, i.plate_no || '—'),
    el('td', {}, i.kind === 'voice'
      ? el('a', { href: `/api/fleet/issues/${i.id}/voice`, target: '_blank' }, `▶ Voice note (${Math.round(i.voice_seconds || 0)}s)`)
      : (i.message || '—')),
    el('td', {}, photoByIssue[i.id] ? el('a', { href: fileUrl(photoByIssue[i.id].id), target: '_blank' }, '📷 Photo') : '—'),
    el('td', {}, badge(i.status)),
    el('td', {}, i.status === 'open'
      ? el('button', {
          class: 'btn btn-ghost btn-sm',
          onclick: async (e) => { await api.patch(`/api/fleet/issues/${i.id}`, { status: 'resolved' }); toast('Marked resolved', 'success'); renderIssuesTab(container); },
        }, 'Mark resolved')
      : '—'),
  ]));
  container.appendChild(el('div', { class: 'card' }, el('div', { class: 'table-wrap' }, el('table', {}, [
    el('thead', {}, el('tr', {}, ['Reported', 'Driver', 'Truck', 'Issue', 'Photo', 'Status', ''].map((h) => el('th', {}, h)))),
    el('tbody', {}, rows.length ? rows : el('tr', { class: 'empty-row' }, el('td', { colspan: 7 }, 'No issues reported.'))),
  ]))));
}

async function renderExpenseRequestsTab(container) {
  clear(container);
  container.appendChild(el('p', { class: 'muted' }, 'Loading…'));
  const { requests } = await api.get('/api/fleet/expense-requests');
  clear(container);
  const rows = requests.map((r) => el('tr', {}, [
    el('td', {}, fmtDate(r.created_at)),
    el('td', {}, r.submitted_by_name || '—'),
    el('td', {}, r.plate_no || '—'),
    el('td', {}, r.category.replace(/_/g, ' ')),
    el('td', { class: 'mono' }, fmtMoney(r.amount)),
    el('td', {}, r.description || '—'),
    el('td', {}, badge(r.status)),
    el('td', {}, r.status === 'pending' ? el('div', { style: { display: 'flex', gap: '6px' } }, [
      el('button', {
        class: 'btn btn-accent btn-sm',
        onclick: async () => { await api.patch(`/api/fleet/expense-requests/${r.id}`, { status: 'accepted' }); toast('Accepted', 'success'); renderExpenseRequestsTab(container); },
      }, 'Accept'),
      el('button', {
        class: 'btn btn-danger btn-sm',
        onclick: async () => { await api.patch(`/api/fleet/expense-requests/${r.id}`, { status: 'declined' }); toast('Declined'); renderExpenseRequestsTab(container); },
      }, 'Decline'),
    ]) : '—'),
  ]));
  container.appendChild(el('div', { class: 'card' }, el('div', { class: 'table-wrap' }, el('table', {}, [
    el('thead', {}, el('tr', {}, ['Date', 'Driver', 'Truck', 'Category', 'Amount', 'Notes', 'Status', ''].map((h) => el('th', {}, h)))),
    el('tbody', {}, rows.length ? rows : el('tr', { class: 'empty-row' }, el('td', { colspan: 8 }, 'No expense requests.'))),
  ]))));
}

async function renderTrucksTab(container) {
  clear(container);
  container.appendChild(el('p', { class: 'muted' }, 'Loading…'));
  const [{ trucks }, { drivers }] = await Promise.all([api.get('/api/fleet/trucks'), api.get('/api/drivers')]);
  clear(container);

  const plateInput = el('input', { placeholder: 'Plate number', required: true });
  const makeInput = el('input', { placeholder: 'Make', value: 'Sinotruk' });
  const modelInput = el('input', { placeholder: 'Model', value: 'HOWO' });
  const kmInput = el('input', { type: 'number', step: '1', placeholder: 'Current odometer (km)' });
  const driverSel = el('select', {}, [el('option', { value: '' }, 'Unassigned'), ...drivers.map((d) => el('option', { value: d.id }, d.name))]);
  const addForm = el('form', {
    class: 'form-row',
    style: { alignItems: 'flex-end', marginBottom: '16px' },
    onsubmit: async (e) => {
      e.preventDefault();
      await api.post('/api/fleet/trucks', {
        plate_no: plateInput.value, driver_id: driverSel.value ? Number(driverSel.value) : null,
        make: makeInput.value || undefined, model: modelInput.value || undefined, current_km: kmInput.value ? Number(kmInput.value) : 0,
      });
      toast('Truck added — default Sinotruk service schedule applied', 'success');
      renderTrucksTab(container);
    },
  }, [
    el('div', { class: 'field' }, [el('label', {}, 'Plate no.'), plateInput]),
    el('div', { class: 'field' }, [el('label', {}, 'Make'), makeInput]),
    el('div', { class: 'field' }, [el('label', {}, 'Model'), modelInput]),
    el('div', { class: 'field' }, [el('label', {}, 'Odometer (km)'), kmInput]),
    el('div', { class: 'field' }, [el('label', {}, 'Driver'), driverSel]),
    el('button', { class: 'btn btn-accent', type: 'submit' }, 'Add truck'),
  ]);

  const rows = trucks.map((t) => el('tr', {}, [
    el('td', {}, t.plate_no),
    el('td', {}, [t.make, t.model].filter(Boolean).join(' ') || '—'),
    el('td', {}, t.driver_name || '—'),
    el('td', { class: 'mono' }, t.current_km != null ? `${Math.round(t.current_km).toLocaleString()} km` : '—'),
    el('td', {}, t.active ? badgeAs('resolved', 'Active') : badgeAs('declined', 'Inactive')),
    el('td', {}, el('button', {
      class: 'btn btn-ghost btn-sm',
      onclick: () => {
        const kmEdit = el('input', { type: 'number', step: '1', value: t.current_km || 0, required: true });
        const form = el('form', {
          onsubmit: async (e) => {
            e.preventDefault();
            await api.patch(`/api/fleet/trucks/${t.id}`, { current_km: Number(kmEdit.value) });
            close(); toast('Odometer updated', 'success'); renderTrucksTab(container);
          },
        }, [
          el('h3', {}, `Update odometer — ${t.plate_no}`),
          el('div', { class: 'field' }, [el('label', {}, 'Current odometer (km)'), kmEdit]),
          el('div', { class: 'modal-actions' }, [el('button', { class: 'btn btn-primary', type: 'submit' }, 'Save')]),
        ]);
        const close = openModal(form);
      },
    }, 'Update odometer')),
  ]));
  container.appendChild(el('div', { class: 'card' }, [
    addForm,
    el('div', { class: 'table-wrap' }, el('table', {}, [
      el('thead', {}, el('tr', {}, ['Plate no.', 'Vehicle', 'Driver', 'Odometer', 'Active', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, rows.length ? rows : el('tr', { class: 'empty-row' }, el('td', { colspan: 6 }, 'No trucks yet.'))),
    ])),
  ]));
}

// ---------------- Maintenance ----------------
const MAINT_STATUS_KEY = { ok: 'resolved', due_soon: 'pending', overdue: 'declined' };

function logServiceForm(trucks, schedule, onSubmit) {
  const truckSel = el('select', { required: true, disabled: !!schedule }, [
    el('option', { value: '' }, 'Select truck'),
    ...trucks.map((t) => el('option', { value: t.id, selected: schedule && schedule.truck_id === t.id }, t.plate_no)),
  ]);
  const serviceInput = el('input', { required: true, value: schedule ? schedule.service_name : '', placeholder: 'e.g. Engine oil & filter change' });
  const odo = el('input', { type: 'number', step: '1', placeholder: 'Odometer reading (km)', value: schedule ? Math.round(schedule.current_km || 0) : '' });
  const cost = el('input', { type: 'number', step: '0.01', placeholder: 'Cost (UGX, optional)' });
  const performedBy = el('input', { placeholder: 'Mechanic / garage (optional)' });
  const dateInput = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
  const notes = el('textarea', { rows: 2, placeholder: 'Notes (optional)' });
  const errorBox = el('div', { class: 'error-text' });
  return el('form', {
    onsubmit: async (e) => {
      e.preventDefault(); errorBox.textContent = '';
      try {
        await onSubmit({
          truck_id: schedule ? schedule.truck_id : Number(truckSel.value),
          schedule_id: schedule ? schedule.id : null,
          service_name: serviceInput.value,
          odometer_km: odo.value ? Number(odo.value) : null,
          cost: cost.value ? Number(cost.value) : null,
          performed_by: performedBy.value || null,
          service_date: dateInput.value,
          notes: notes.value || null,
        });
      } catch (err) { errorBox.textContent = err.message; }
    },
  }, [
    el('h3', {}, schedule ? `Log service — ${schedule.service_name}` : 'Log a service'),
    el('div', { class: 'field' }, [el('label', {}, 'Truck'), truckSel]),
    el('div', { class: 'field' }, [el('label', {}, 'Service done'), serviceInput]),
    el('div', { class: 'form-row' }, [
      el('div', { class: 'field' }, [el('label', {}, 'Odometer (km)'), odo]),
      el('div', { class: 'field' }, [el('label', {}, 'Date'), dateInput]),
    ]),
    el('div', { class: 'form-row' }, [
      el('div', { class: 'field' }, [el('label', {}, 'Cost (UGX)'), cost]),
      el('div', { class: 'field' }, [el('label', {}, 'Mechanic/garage'), performedBy]),
    ]),
    el('div', { class: 'field' }, [el('label', {}, 'Notes'), notes]),
    errorBox,
    el('div', { class: 'modal-actions' }, [el('button', { class: 'btn btn-primary', type: 'submit' }, 'Save')]),
  ]);
}

function customScheduleForm(trucks, onSubmit) {
  const truckSel = el('select', { required: true }, [el('option', { value: '' }, 'Select truck'), ...trucks.map((t) => el('option', { value: t.id }, t.plate_no))]);
  const serviceInput = el('input', { required: true, placeholder: 'e.g. Windscreen wiper replacement' });
  const km = el('input', { type: 'number', step: '1', placeholder: 'Every N km (optional)' });
  const days = el('input', { type: 'number', step: '1', placeholder: 'Every N days (optional)' });
  const errorBox = el('div', { class: 'error-text' });
  return el('form', {
    onsubmit: async (e) => {
      e.preventDefault(); errorBox.textContent = '';
      if (!km.value && !days.value) { errorBox.textContent = 'Set an interval in km, days, or both'; return; }
      try {
        await onSubmit({ truck_id: Number(truckSel.value), service_name: serviceInput.value, interval_km: km.value ? Number(km.value) : null, interval_days: days.value ? Number(days.value) : null });
      } catch (err) { errorBox.textContent = err.message; }
    },
  }, [
    el('h3', {}, 'Add a custom service item'),
    el('div', { class: 'field' }, [el('label', {}, 'Truck'), truckSel]),
    el('div', { class: 'field' }, [el('label', {}, 'Service name'), serviceInput]),
    el('div', { class: 'form-row' }, [
      el('div', { class: 'field' }, [el('label', {}, 'Interval (km)'), km]),
      el('div', { class: 'field' }, [el('label', {}, 'Interval (days)'), days]),
    ]),
    errorBox,
    el('div', { class: 'modal-actions' }, [el('button', { class: 'btn btn-primary', type: 'submit' }, 'Add')]),
  ]);
}

async function renderMaintenanceTab(container) {
  clear(container);
  container.appendChild(el('p', { class: 'muted' }, 'Loading…'));
  const [{ schedules }, { logs }, { trucks }] = await Promise.all([
    api.get('/api/fleet/maintenance/schedules'), api.get('/api/fleet/maintenance/logs'), api.get('/api/fleet/trucks'),
  ]);
  clear(container);

  container.appendChild(el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginBottom: '12px' } }, [
    el('button', {
      class: 'btn btn-ghost btn-sm',
      onclick: () => {
        const form = customScheduleForm(trucks, async (payload) => { await api.post('/api/fleet/maintenance/schedules', payload); close(); toast('Service item added', 'success'); renderMaintenanceTab(container); });
        const close = openModal(form);
      },
    }, '+ Custom service item'),
    el('button', {
      class: 'btn btn-accent btn-sm',
      onclick: () => {
        const form = logServiceForm(trucks, null, async (payload) => { await api.post('/api/fleet/maintenance/logs', payload); close(); toast('Service logged', 'success'); renderMaintenanceTab(container); });
        const close = openModal(form);
      },
    }, '+ Log a service'),
  ]));

  const sorted = [...schedules].sort((a, b) => {
    const rank = { overdue: 0, due_soon: 1, ok: 2 };
    return rank[a.status] - rank[b.status];
  });
  const schedRows = sorted.map((s) => el('tr', {}, [
    el('td', {}, s.plate_no),
    el('td', {}, s.service_name),
    el('td', {}, [s.interval_km ? `${s.interval_km.toLocaleString()} km` : null, s.interval_days ? `${s.interval_days} days` : null].filter(Boolean).join(' / ')),
    el('td', {}, s.due_km ? `${Math.round(s.due_km).toLocaleString()} km` : (s.due_date ? fmtDate(s.due_date) : '—')),
    el('td', {}, badgeAs(MAINT_STATUS_KEY[s.status], s.status.replace('_', ' '))),
    el('td', {}, el('button', {
      class: 'btn btn-ghost btn-sm',
      onclick: () => {
        const form = logServiceForm(trucks, s, async (payload) => { await api.post('/api/fleet/maintenance/logs', payload); close(); toast('Service logged', 'success'); renderMaintenanceTab(container); });
        const close = openModal(form);
      },
    }, 'Log service')),
  ]));

  const historyRows = logs.slice(0, 30).map((l) => el('tr', {}, [
    el('td', {}, fmtDate(l.service_date)),
    el('td', {}, l.plate_no),
    el('td', {}, l.service_name),
    el('td', { class: 'mono' }, l.odometer_km ? `${Math.round(l.odometer_km).toLocaleString()} km` : '—'),
    el('td', { class: 'mono' }, l.cost ? fmtMoney(l.cost) : '—'),
    el('td', {}, l.performed_by || '—'),
  ]));

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', {}, 'Due for service'),
    el('div', { class: 'table-wrap' }, el('table', {}, [
      el('thead', {}, el('tr', {}, ['Truck', 'Service', 'Interval', 'Due at', 'Status', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, schedRows.length ? schedRows : el('tr', { class: 'empty-row' }, el('td', { colspan: 6 }, 'No service schedules yet — add a truck to get the default Sinotruk schedule.'))),
    ])),
  ]));
  container.appendChild(el('div', { class: 'card' }, [
    el('h3', {}, 'Service history'),
    el('div', { class: 'table-wrap' }, el('table', {}, [
      el('thead', {}, el('tr', {}, ['Date', 'Truck', 'Service', 'Odometer', 'Cost', 'Mechanic'].map((h) => el('th', {}, h)))),
      el('tbody', {}, historyRows.length ? historyRows : el('tr', { class: 'empty-row' }, el('td', { colspan: 6 }, 'No services logged yet.'))),
    ])),
  ]));
}

// ---------------- Vehicle Documents ----------------
const DOC_STATUS_KEY = { valid: 'resolved', expiring_soon: 'pending', expired: 'declined' };
const DOC_TYPE_LABEL = { insurance: 'Insurance', road_license: 'Road license', inspection: 'Inspection certificate', other: 'Other' };

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function vehicleDocForm(trucks, onSubmit) {
  const truckSel = el('select', { required: true }, [el('option', { value: '' }, 'Select truck'), ...trucks.map((t) => el('option', { value: t.id }, t.plate_no))]);
  const docType = el('select', {}, Object.entries(DOC_TYPE_LABEL).map(([v, l]) => el('option', { value: v }, l)));
  const docNumber = el('input', { placeholder: 'Policy / permit number (optional)' });
  const issued = el('input', { type: 'date' });
  const expiry = el('input', { type: 'date', required: true });
  const fileInput = el('input', { type: 'file', accept: 'image/*,application/pdf' });
  const errorBox = el('div', { class: 'error-text' });
  return el('form', {
    onsubmit: async (e) => {
      e.preventDefault(); errorBox.textContent = '';
      try {
        const payload = { truck_id: Number(truckSel.value), doc_type: docType.value, doc_number: docNumber.value || null, issued_date: issued.value || null, expiry_date: expiry.value };
        const file = fileInput.files[0];
        if (file) {
          payload.file_base64 = await fileToBase64(file);
          payload.file_name = file.name;
          payload.mime_type = file.type;
        }
        await onSubmit(payload);
      } catch (err) { errorBox.textContent = err.message; }
    },
  }, [
    el('h3', {}, 'Add / renew a vehicle document'),
    el('div', { class: 'field' }, [el('label', {}, 'Truck'), truckSel]),
    el('div', { class: 'field' }, [el('label', {}, 'Document type'), docType]),
    el('div', { class: 'field' }, [el('label', {}, 'Number (optional)'), docNumber]),
    el('div', { class: 'form-row' }, [
      el('div', { class: 'field' }, [el('label', {}, 'Issued'), issued]),
      el('div', { class: 'field' }, [el('label', {}, 'Expires'), expiry]),
    ]),
    el('div', { class: 'field' }, [el('label', {}, 'Attach a copy (optional)'), fileInput]),
    errorBox,
    el('div', { class: 'modal-actions' }, [el('button', { class: 'btn btn-primary', type: 'submit' }, 'Save')]),
  ]);
}

async function renderVehicleDocsTab(container) {
  clear(container);
  container.appendChild(el('p', { class: 'muted' }, 'Loading…'));
  const [{ documents }, { trucks }, docsFiles] = await Promise.all([
    api.get('/api/fleet/vehicle-documents'), api.get('/api/fleet/trucks'), api.get('/api/documents?ref_table=vehicle_documents'),
  ]);
  clear(container);
  const fileById = {};
  docsFiles.documents.forEach((d) => { fileById[d.ref_id] = d; });

  container.appendChild(el('div', { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: '12px' } },
    el('button', {
      class: 'btn btn-accent btn-sm',
      onclick: () => {
        const form = vehicleDocForm(trucks, async (payload) => { await api.post('/api/fleet/vehicle-documents', payload); close(); toast('Document saved', 'success'); renderVehicleDocsTab(container); });
        const close = openModal(form);
      },
    }, '+ Add / renew document')));

  const statusRank = { expired: 0, expiring_soon: 1, valid: 2 };
  const sorted = [...documents].sort((a, b) => statusRank[a.status] - statusRank[b.status]);
  const rows = sorted.map((d) => el('tr', {}, [
    el('td', {}, d.plate_no),
    el('td', {}, DOC_TYPE_LABEL[d.doc_type] || d.doc_type),
    el('td', {}, d.doc_number || '—'),
    el('td', {}, d.expiry_date ? fmtDate(d.expiry_date) : '—'),
    el('td', {}, badgeAs(DOC_STATUS_KEY[d.status], d.status.replace('_', ' '))),
    el('td', {}, fileById[d.id] ? el('a', { href: fileUrl(fileById[d.id].id), target: '_blank' }, 'View') : '—'),
  ]));
  container.appendChild(el('div', { class: 'card' }, el('div', { class: 'table-wrap' }, el('table', {}, [
    el('thead', {}, el('tr', {}, ['Truck', 'Document', 'Number', 'Expires', 'Status', 'File'].map((h) => el('th', {}, h)))),
    el('tbody', {}, rows.length ? rows : el('tr', { class: 'empty-row' }, el('td', { colspan: 6 }, 'No vehicle documents on file yet.'))),
  ]))));
}

// ---------------- Fuel ----------------
function fuelForm(trucks, drivers, onSubmit) {
  const truckSel = el('select', { required: true }, [el('option', { value: '' }, 'Select truck'), ...trucks.map((t) => el('option', { value: t.id }, t.plate_no))]);
  const driverSel = el('select', {}, [el('option', { value: '' }, 'Use truck\'s assigned driver'), ...drivers.map((d) => el('option', { value: d.id }, d.name))]);
  const odo = el('input', { type: 'number', step: '1', placeholder: 'Odometer reading (km, optional)' });
  const liters = el('input', { type: 'number', step: '0.01', placeholder: 'Liters (optional)' });
  const amount = el('input', { type: 'number', step: '0.01', required: true, placeholder: 'Amount (UGX)' });
  const station = el('input', { placeholder: 'Fuel station (optional)' });
  const dateInput = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
  const errorBox = el('div', { class: 'error-text' });
  return el('form', {
    onsubmit: async (e) => {
      e.preventDefault(); errorBox.textContent = '';
      try {
        await onSubmit({
          truck_id: Number(truckSel.value), driver_id: driverSel.value ? Number(driverSel.value) : null,
          odometer_km: odo.value ? Number(odo.value) : null, liters: liters.value ? Number(liters.value) : null,
          amount: Number(amount.value), station: station.value || null, fuel_date: dateInput.value,
        });
      } catch (err) { errorBox.textContent = err.message; }
    },
  }, [
    el('h3', {}, 'Log a fuel fill-up'),
    el('div', { class: 'field' }, [el('label', {}, 'Truck'), truckSel]),
    el('div', { class: 'field' }, [el('label', {}, 'Driver'), driverSel]),
    el('div', { class: 'form-row' }, [
      el('div', { class: 'field' }, [el('label', {}, 'Odometer (km)'), odo]),
      el('div', { class: 'field' }, [el('label', {}, 'Liters'), liters]),
    ]),
    el('div', { class: 'form-row' }, [
      el('div', { class: 'field' }, [el('label', {}, 'Amount (UGX)'), amount]),
      el('div', { class: 'field' }, [el('label', {}, 'Date'), dateInput]),
    ]),
    el('div', { class: 'field' }, [el('label', {}, 'Station (optional)'), station]),
    errorBox,
    el('div', { class: 'modal-actions' }, [el('button', { class: 'btn btn-primary', type: 'submit' }, 'Save')]),
  ]);
}

async function renderFuelTab(container) {
  clear(container);
  container.appendChild(el('p', { class: 'muted' }, 'Loading…'));
  const [{ logs }, { trucks }, { drivers }] = await Promise.all([
    api.get('/api/fleet/fuel-logs'), api.get('/api/fleet/trucks'), api.get('/api/drivers'),
  ]);
  clear(container);

  container.appendChild(el('div', { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: '12px' } },
    el('button', {
      class: 'btn btn-accent btn-sm',
      onclick: () => {
        const form = fuelForm(trucks, drivers, async (payload) => { await api.post('/api/fleet/fuel-logs', payload); close(); toast('Fuel logged', 'success'); renderFuelTab(container); });
        const close = openModal(form);
      },
    }, '+ Log fuel')));

  const total = logs.reduce((sum, l) => sum + (l.amount || 0), 0);
  const rows = logs.map((l) => el('tr', {}, [
    el('td', {}, fmtDate(l.fuel_date)),
    el('td', {}, l.plate_no),
    el('td', {}, l.driver_name || '—'),
    el('td', { class: 'mono' }, l.odometer_km ? `${Math.round(l.odometer_km).toLocaleString()} km` : '—'),
    el('td', { class: 'mono' }, l.liters ? `${l.liters} L` : '—'),
    el('td', { class: 'mono' }, fmtMoney(l.amount)),
    el('td', {}, l.station || '—'),
  ]));
  container.appendChild(el('div', { class: 'card' }, [
    el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '12px' } }, [
      el('h3', { class: 'mt-0' }, 'Fuel log'),
      el('div', { class: 'muted' }, `Total: ${fmtMoney(total)}`),
    ]),
    el('div', { class: 'table-wrap' }, el('table', {}, [
      el('thead', {}, el('tr', {}, ['Date', 'Truck', 'Driver', 'Odometer', 'Liters', 'Amount', 'Station'].map((h) => el('th', {}, h)))),
      el('tbody', {}, rows.length ? rows : el('tr', { class: 'empty-row' }, el('td', { colspan: 7 }, 'No fuel logged yet.'))),
    ])),
  ]));
}

export async function renderFleet(content, user) {
  clear(content);
  content.appendChild(el('div', { class: 'page-header' }, [
    el('div', {}, [el('h2', {}, 'Fleet'), el('p', {}, 'Loads, issue reports, expense approvals, and trucks.')]),
  ]));

  const tabsDef = [
    ['loads', 'Loads', renderLoadsTab],
    ['issues', 'Issues', renderIssuesTab],
    ['expenses', 'Expense requests', renderExpenseRequestsTab],
    ['trucks', 'Trucks', renderTrucksTab],
    ['maintenance', 'Maintenance', renderMaintenanceTab],
    ['vehicledocs', 'Vehicle Docs', renderVehicleDocsTab],
    ['fuel', 'Fuel', renderFuelTab],
  ];
  const body = el('div', {});
  const tabsBar = el('div', { class: 'tabs' });

  function activate(key) {
    tabsBar.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.key === key));
    const entry = tabsDef.find(([k]) => k === key);
    entry[2](body);
  }
  tabsDef.forEach(([key, label]) => {
    tabsBar.appendChild(el('div', { class: 'tab', 'data-key': key, onclick: () => activate(key) }, label));
  });

  content.appendChild(tabsBar);
  content.appendChild(body);
  activate('loads');
}
