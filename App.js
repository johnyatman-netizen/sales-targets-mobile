import React, { useEffect, useMemo, useState } from 'react';
import { SafeAreaView, View, Text, TextInput, TouchableOpacity, FlatList, ScrollView, Alert, Modal, Platform, StyleSheet, Linking } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Svg, { Rect, G, Text as SvgText } from 'react-native-svg';
import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';

/*************************
 * Constants & Utilities  *
 *************************/
const DEFAULT_TARGETS = {
  connects: 800,
  geoData: 50,
  buyerAppointments: 20,
  marketAppraisals: 25,
  listingsGenerated: 1,
};

const KPI_LABELS = {
  connects: 'Connects',
  geoData: 'Geo Data',
  buyerAppointments: 'Buyer Appointments',
  marketAppraisals: 'Market Appraisals',
  listingsGenerated: 'Listings Generated',
};

const DEFAULT_EMAIL = 'john.yatman@raywhite.com';
const DEFAULT_SEND_HOUR = 18; // 18:00 (6pm) local time
const EMAIL_WEBHOOK_URL_KEY = 'salesTargetsMobileV1_emailWebhookUrl';
const EMAIL_TO_KEY = 'salesTargetsMobileV1_emailTo';
const SEND_HOUR_KEY = 'salesTargetsMobileV1_sendHour';

function monthKey(date = new Date()) {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  return `${y}-${m}`; // e.g. 2025-08
}

const LS_KEY = 'salesTargetsMobileV1';

async function safeStoreGet(key) {
  try { const raw = await AsyncStorage.getItem(key); return raw; } catch { return null; }
}
async function safeStoreSet(key, value) {
  try { await AsyncStorage.setItem(key, value); } catch {}
}

function pct(n, d) { if (!d || d === 0) return 0; return Math.min(100, Math.round((n / d) * 100)); }

function toCSV(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v) => `"${String(v).replaceAll('"', '""')}"`;
  const lines = [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h] ?? '')).join(','))];
  return lines.join('\n');
}

function genId() {
  try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID(); } catch {}
  const rand = Math.random().toString(36).slice(2, 10);
  return `id-${rand}-${Date.now()}`;
}

function buildSnapshotText({ month, associates, targets }) {
  const head = `Sales Targets – ${month}`;
  const count = associates.length;
  const totals = ['connects','geoData','buyerAppointments','marketAppraisals','listingsGenerated'].map(k => {
    const sum = associates.reduce((s,a)=>s+Number(a.metrics?.[k]||0),0);
    const teamTarget = (Number(targets[k])||0) * Math.max(1, count||1);
    const p = pct(sum, teamTarget);
    return `${KPI_LABELS[k]}: ${sum} / ${teamTarget} (${p}%)`;
  }).join('\n');
  return `${head}\nTeam Size: ${count}\n\n${totals}`;
}

function buildCSVFromAssociates(associates){
  const rows = associates.map((a) => ({
    Name: a.name,
    Connects: a.metrics.connects || 0,
    GeoData: a.metrics.geoData || 0,
    BuyerAppointments: a.metrics.buyerAppointments || 0,
    MarketAppraisals: a.metrics.marketAppraisals || 0,
    ListingsGenerated: a.metrics.listingsGenerated || 0,
  }));
  return toCSV(rows);
}

/*********************
 * Error Boundary     *
 *********************/
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('App error:', error, info); }
  render() {
    if (this.state.error) {
      const msg = String(this.state.error?.message || this.state.error);
      return (
        <SafeAreaView style={{ flex: 1, padding: 16 }}>
          <Text style={{ fontSize: 18, fontWeight: '600', marginBottom: 8 }}>Something went wrong</Text>
          <View style={{ padding: 12, borderRadius: 12, borderWidth: 1, borderColor: '#ddd' }}>
            <Text style={{ fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' }}>{msg}</Text>
          </View>
          <TouchableOpacity style={[styles.btn, { backgroundColor: '#ef4444', marginTop: 12 }]} onPress={() => this.setState({ error: null })}>
            <Text style={styles.btnText}>Try Again</Text>
          </TouchableOpacity>
        </SafeAreaView>
      );
    }
    return this.props.children;
  }
}

/*********************
 * Simple Bar Chart   *
 *********************/
function BarChart({ data }) {
  // data: [{ label, actual, target }]
  const width = 360; const height = 200; const padding = 28; const barWidth = 24; const gap = 32;
  const maxVal = Math.max(1, ...data.map(d => Math.max(d.actual, d.target)));
  const scale = (v) => (v / maxVal) * (height - padding * 2);
  return (
    <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}>
      <Rect x={padding} y={padding} width={1} height={height - padding * 2} fill="#e5e7eb" />
      <Rect x={padding} y={height - padding} width={width - padding * 2} height={1} fill="#e5e7eb" />
      <G>
        {data.map((d, i) => {
          const x0 = padding + 20 + i * (barWidth * 2 + gap);
          const hTarget = scale(d.target);
          const hActual = scale(d.actual);
          return (
            <G key={i}>
              <Rect x={x0} y={height - padding - hTarget} width={barWidth} height={hTarget} fill="#e5e7eb" />
              <Rect x={x0 + barWidth + 4} y={height - padding - hActual} width={barWidth} height={hActual} fill="#3b82f6" />
              <SvgText x={x0 + barWidth} y={height - padding + 14} fontSize="10" textAnchor="middle">{d.label}</SvgText>
            </G>
          );
        })}
      </G>
    </Svg>
  );
}

/*********************
 * Background Email Task
 *********************/
const TASK_NAME = 'salesTargetsDailyEmailTask';

TaskManager.defineTask(TASK_NAME, async () => {
  try {
    const raw = await AsyncStorage.getItem(LS_KEY);
    const store = raw ? JSON.parse(raw) : {};
    const month = monthKey();
    const state = store[month] || { targets: DEFAULT_TARGETS, associates: [] };
    const to = (await AsyncStorage.getItem(EMAIL_TO_KEY)) || DEFAULT_EMAIL;
    const webhook = await AsyncStorage.getItem(EMAIL_WEBHOOK_URL_KEY);
    const sendHour = Number((await AsyncStorage.getItem(SEND_HOUR_KEY)) || DEFAULT_SEND_HOUR);

    // Send within ±30 minutes of the configured hour
    const now = new Date();
    const minutesNow = now.getHours() * 60 + now.getMinutes();
    const minutesTarget = sendHour * 60;
    const withinWindow = Math.abs(minutesNow - minutesTarget) <= 30;
    if (!withinWindow) return BackgroundFetch.BackgroundFetchResult.NoData;

    const subject = `Daily KPI – ${month}`;
    const text = buildSnapshotText({ month, associates: state.associates, targets: state.targets });
    const csv = buildCSVFromAssociates(state.associates);

    if (webhook) {
      const res = await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to, subject, text, csv, month }) });
      const ok = res.ok;
      return ok ? BackgroundFetch.BackgroundFetchResult.NewData : BackgroundFetch.BackgroundFetchResult.Failed;
    } else {
      console.log('No EMAIL_WEBHOOK_URL configured; skipping background email.');
      return BackgroundFetch.BackgroundFetchResult.NoData;
    }
  } catch (e) {
    console.log('Email task error', e);
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

async function registerDailyEmailTask() {
  try {
    const status = await BackgroundFetch.getStatusAsync();
    if (status === BackgroundFetch.BackgroundFetchStatus.Restricted || status === BackgroundFetch.BackgroundFetchStatus.Denied) {
      console.log('BackgroundFetch unavailable');
      return false;
    }
    await BackgroundFetch.registerTaskAsync(TASK_NAME, { minimumInterval: 60 * 30, stopOnTerminate: false, startOnBoot: true }); // 30 min
    return true;
  } catch (e) {
    console.log('registerDailyEmailTask error', e);
    return false;
  }
}

/*********************
 * Main Application   *
 *********************/
export default function App() {
  const [store, setStore] = useState({});
  const [month, setMonth] = useState(monthKey());

  const monthState = store[month] || { targets: DEFAULT_TARGETS, associates: [] };

  const [targets, setTargets] = useState(monthState.targets);
  const [associates, setAssociates] = useState(monthState.associates);

  const [activeTab, setActiveTab] = useState('team');
  const [newName, setNewName] = useState('');
  const [importVisible, setImportVisible] = useState(false);
  const [importText, setImportText] = useState('');
  const [tests, setTests] = useState([]);

  const [emailTo, setEmailTo] = useState(DEFAULT_EMAIL);
  const [emailWebhook, setEmailWebhook] = useState('');
  const [sendHour, setSendHour] = useState(String(DEFAULT_SEND_HOUR));

  // Load persisted store & email settings on mount
  useEffect(() => {
    (async () => {
      const raw = await safeStoreGet(LS_KEY);
      const obj = raw ? JSON.parse(raw) : {};
      if (!obj[month]) {
        obj[month] = { targets: { ...DEFAULT_TARGETS }, associates: [
          { id: genId(), name: 'Alex', metrics: { connects: 120, geoData: 10, buyerAppointments: 3, marketAppraisals: 4, listingsGenerated: 0 } },
          { id: genId(), name: 'Bianca', metrics: { connects: 300, geoData: 18, buyerAppointments: 7, marketAppraisals: 10, listingsGenerated: 1 } },
          { id: genId(), name: 'Chris', metrics: { connects: 90, geoData: 5, buyerAppointments: 1, marketAppraisals: 2, listingsGenerated: 0 } },
        ] };
      }
      setStore(obj); setTargets(obj[month].targets); setAssociates(obj[month].associates);

      const savedTo = (await safeStoreGet(EMAIL_TO_KEY)) || DEFAULT_EMAIL; setEmailTo(savedTo.replace(/"/g,''));
      const savedWebhook = (await safeStoreGet(EMAIL_WEBHOOK_URL_KEY)) || ''; setEmailWebhook(savedWebhook?.replace(/"/g,''));
      const savedHour = (await safeStoreGet(SEND_HOUR_KEY)) || String(DEFAULT_SEND_HOUR); setSendHour(String(savedHour));

      await registerDailyEmailTask();
    })();
  }, []);

  // Persist changes
  useEffect(() => {
    const next = { ...store, [month]: { targets, associates } };
    setStore(next);
    safeStoreSet(LS_KEY, JSON.stringify(next));
  }, [targets, associates, month]);

  // Persist email settings
  useEffect(() => { safeStoreSet(EMAIL_TO_KEY, emailTo); }, [emailTo]);
  useEffect(() => { safeStoreSet(EMAIL_WEBHOOK_URL_KEY, emailWebhook); }, [emailWebhook]);
  useEffect(() => { safeStoreSet(SEND_HOUR_KEY, String(sendHour)); }, [sendHour]);

  // Month list (last 18 months)
  const months = useMemo(() => {
    const arr = []; const now = new Date();
    for (let i = 0; i < 18; i++) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); arr.push({ key: monthKey(d), label: d.toLocaleString(undefined, { month: 'long', year: 'numeric' }) }); }
    return arr;
  }, []);

  const teamTotals = useMemo(() => {
    const totals = { connects: 0, geoData: 0, buyerAppointments: 0, marketAppraisals: 0, listingsGenerated: 0 };
    associates.forEach((a) => { Object.keys(totals).forEach((k) => (totals[k] += Number(a.metrics?.[k] || 0))); });
    return totals;
  }, [associates]);

  const teamTargets = useMemo(() => {
    const count = Math.max(1, associates.length || 1);
    const agg = {}; Object.keys(targets).forEach((k) => (agg[k] = (Number(targets[k]) || 0) * count));
    return agg;
  }, [targets, associates.length]);

  const chartData = useMemo(() => (Object.keys(KPI_LABELS).map((k) => ({ label: KPI_LABELS[k], actual: teamTotals[k], target: teamTargets[k] }))), [teamTotals, teamTargets]);

  const leaderboard = useMemo(() => {
    const items = associates.map((a) => { const progress = Object.keys(KPI_LABELS).reduce((acc, k) => acc + pct(a.metrics[k] || 0, targets[k]), 0) / Object.keys(KPI_LABELS).length; return { id: a.id, name: a.name, listings: a.metrics.listingsGenerated || 0, progress }; });
    return items.sort((a, b) => b.listings - a.listings || b.progress - a.progress).slice(0, 5);
  }, [associates, targets]);

  function addAssociate() { if (!newName.trim()) return; setAssociates((prev) => ([...prev, { id: genId(), name: newName.trim(), metrics: { connects: 0, geoData: 0, buyerAppointments: 0, marketAppraisals: 0, listingsGenerated: 0 } }])); setNewName(''); }

  function updateMetric(id, key, value) { const v = Number(value); if (Number.isNaN(v) || v < 0) return; setAssociates((prev) => prev.map((a) => (a.id === id ? { ...a, metrics: { ...a.metrics, [key]: v } } : a))); }
  function deleteAssociate(id) { setAssociates((prev) => prev.filter((a) => a.id !== id)); }

  function exportJSON() {
    const payload = { month, targets, associates };
    Alert.alert('Export JSON', 'JSON printed to console');
    console.log('EXPORT_JSON', JSON.stringify(payload));
  }
  function exportCSV() { const csv = buildCSVFromAssociates(associates); Alert.alert('Export CSV', 'CSV printed to console'); console.log('EXPORT_CSV\n' + csv); }

  function importJSON() {
    try { const obj = JSON.parse(importText); if (!obj || typeof obj !== 'object') throw new Error('Invalid JSON'); if (obj.month && obj.targets && obj.associates) { setMonth(obj.month); setTargets(obj.targets); setAssociates(obj.associates); setImportVisible(false); setImportText(''); } else { throw new Error('JSON missing keys {month, targets, associates}'); } }
    catch (e) { Alert.alert('Import failed', String(e?.message || e)); }
  }
  function resetMonth() { setTargets({ ...DEFAULT_TARGETS }); setAssociates([]); }

  async function sendDailyEmailNow() {
    try {
      const subject = `Daily KPI – ${month}`;
      const text = buildSnapshotText({ month, associates, targets });
      const csv = buildCSVFromAssociates(associates);
      if (emailWebhook) {
        const res = await fetch(emailWebhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: emailTo, subject, text, csv, month }) });
        if (!res.ok) throw new Error(`Webhook responded ${res.status}`);
        Alert.alert('Email sent', `Daily summary sent to ${emailTo}`);
      } else {
        const mailto = `mailto:${encodeURIComponent(emailTo)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
        const supported = await Linking.canOpenURL(mailto);
        if (supported) Linking.openURL(mailto); else Alert.alert('No email webhook configured', 'Set EMAIL_WEBHOOK_URL in Settings to enable automatic sending.');
      }
    } catch (e) {
      Alert.alert('Send failed', String(e?.message || e));
    }
  }

  // Tests
  function runTests() {
    const results = [];
    function t(name, fn) { try { const out = fn(); results.push({ name, pass: out === true, details: out === true ? 'OK' : String(out) }); } catch (e) { results.push({ name, pass: false, details: String(e?.message || e) }); } }
    t('pct handles zero denominator', () => pct(5, 0) === 0);
    t('pct clamps to 100', () => pct(120, 100) === 100);
    t('pct normal case', () => pct(50, 100) === 50);
    t('monthKey formats YYYY-MM', () => monthKey(new Date(2025, 7, 1)) === '2025-08');
    t('toCSV empty', () => toCSV([]) === '');
    t('toCSV escaping', () => { const csv = toCSV([{ A: 'a, b', B: '"q"' }]); return csv.startsWith('A,B') && csv.includes('"a, b"') && csv.includes('""q""'); });
    t('genId unique-ish', () => { const a = genId(); const b = genId(); return a !== b && a.startsWith('id-'); });
    t('snapshot text includes all KPIs', () => { const txt = buildSnapshotText({ month: '2025-08', associates: [{ metrics: { connects:1, geoData:2, buyerAppointments:3, marketAppraisals:4, listingsGenerated:5 } }], targets: DEFAULT_TARGETS }); return ['Connects','Geo Data','Buyer Appointments','Market Appraisals','Listings Generated'].every(s=>txt.includes(s)); });
    setTests(results);
  }
  useEffect(() => { runTests(); }, []);

  // UI Components
  const TabButton = ({ id, label }) => (
    <TouchableOpacity onPress={() => setActiveTab(id)} style={[styles.tabBtn, activeTab === id && styles.tabBtnActive]}>
      <Text style={[styles.tabText, activeTab === id && styles.tabTextActive]}>{label}</Text>
    </TouchableOpacity>
  );

  const TargetCard = ({ k }) => {
    const actual = teamTotals[k]; const target = teamTargets[k]; const percent = pct(actual, target);
    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{KPI_LABELS[k]}</Text>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
          <Text style={{ fontSize: 22, fontWeight: '700' }}>{actual}</Text>
          <Text style={{ color: '#6b7280' }}>Target {target}</Text>
        </View>
        <View style={styles.progressOuter}><View style={[styles.progressInner, { width: `${percent}%` }]} /></View>
        <Text style={{ alignSelf: 'flex-end', color: '#6b7280', fontSize: 12 }}>{percent}%</Text>
      </View>
    );
  };

  return (
    <ErrorBoundary>
      <SafeAreaView style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          {/* Header */}
          <Text style={{ fontSize: 22, fontWeight: '700' }}>Sales Associates Monthly Targets</Text>
          <Text style={{ color: '#6b7280', marginTop: 4 }}>Daily email (default 6:00pm local) will send a summary and CSV to your agency.</Text>

          {/* Month Picker */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 12 }}>
            {months.map((m) => (
              <TouchableOpacity key={m.key} onPress={() => setMonth(m.key)} style={[styles.chip, month === m.key && styles.chipActive]}>
                <Text style={[styles.chipText, month === m.key && styles.chipTextActive]}>{m.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* Snapshot Cards */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 16 }}>
            {Object.keys(KPI_LABELS).map((k) => (
              <View key={k} style={{ width: '48%' }}>
                <TargetCard k={k} />
              </View>
            ))}
          </View>

          {/* Tabs */}
          <View style={{ flexDirection: 'row', marginTop: 16 }}>
            <TabButton id="team" label="Team" />
            <TabButton id="associates" label="Associates" />
            <TabButton id="settings" label="Settings" />
            <TabButton id="tests" label="Tests" />
          </View>

          {activeTab === 'team' && (
            <View style={{ marginTop: 12 }}>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Team vs Target</Text>
                <BarChart data={chartData} />
                <Text style={{ marginTop: 6, color: '#6b7280' }}>Team target scales with headcount ({associates.length || 0}). Per-person target shown in Settings.</Text>
              </View>

              <View style={styles.card}>
                <Text style={styles.cardTitle}>Leaderboard</Text>
                {associates.length === 0 ? (
                  <Text style={{ color: '#6b7280' }}>Add associates to see rankings.</Text>
                ) : (
                  leaderboard.map((l, i) => (
                    <View key={l.id} style={styles.rowBetween}>
                      <Text style={{ fontWeight: '600' }}>{i + 1}. {l.name}</Text>
                      <Text>Listings {l.listings} • {Math.round(l.progress)}%</Text>
                    </View>
                  ))
                )}
              </View>
            </View>
          )}

          {activeTab === 'associates' && (
            <View style={{ marginTop: 12 }}>
              <View style={styles.row}>
                <TextInput placeholder="Associate name" value={newName} onChangeText={setNewName} style={[styles.input, { flex: 1 }]} />
                <TouchableOpacity style={styles.btn} onPress={addAssociate}><Text style={styles.btnText}>Add</Text></TouchableOpacity>
              </View>

              {associates.length === 0 ? (
                <Text style={{ color: '#6b7280', marginTop: 8 }}>No associates yet. Add one to get started.</Text>
              ) : (
                <View style={[styles.card, { padding: 0, overflow: 'hidden' }]}> 
                  <View style={[styles.rowBetween, styles.tableHeader]}>
                    <Text style={styles.th}>Name</Text>
                    {Object.keys(KPI_LABELS).map((k) => (<Text key={k} style={styles.thShort}>{KPI_LABELS[k]}</Text>))}
                    <Text style={styles.thShort}>Prog</Text>
                    <Text style={styles.thShort}>Del</Text>
                  </View>
                  <FlatList
                    data={associates}
                    keyExtractor={(a) => a.id}
                    renderItem={({ item: a }) => {
                      const prog = Math.round((Object.keys(KPI_LABELS).reduce((acc, k) => acc + pct(a.metrics[k] || 0, targets[k]), 0) / Object.keys(KPI_LABELS).length));
                      return (
                        <View style={[styles.rowBetween, styles.tableRow]}>
                          <Text style={[styles.td, { flex: 1 }]}>{a.name}</Text>
                          {Object.keys(KPI_LABELS).map((k) => (
                            <TextInput key={k} keyboardType="number-pad" value={String(a.metrics[k] ?? 0)} onChangeText={(txt) => updateMetric(a.id, k, txt)} style={[styles.input, styles.inputTd]} />
                          ))}
                          <Text style={styles.tdShort}>{prog}%</Text>
                          <TouchableOpacity onPress={() => deleteAssociate(a.id)}><Text style={[styles.tdShort, { color: '#ef4444' }]}>X</Text></TouchableOpacity>
                        </View>
                      );
                    }}
                  />
                </View>
              )}
            </View>
          )}

          {activeTab === 'settings' && (
            <View style={{ marginTop: 12 }}>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Per-Person Monthly Targets</Text>
                {Object.keys(KPI_LABELS).map((k) => (
                  <View key={k} style={styles.row}> 
                    <Text style={{ width: 160 }}>{KPI_LABELS[k]}</Text>
                    <TextInput keyboardType="number-pad" value={String(targets[k])} onChangeText={(txt) => setTargets((t) => ({ ...t, [k]: Number(txt) }))} style={[styles.input, { flex: 1 }]} />
                  </View>
                ))}
                <Text style={{ color: '#6b7280', marginTop: 6 }}>These targets apply to each associate. Team targets scale automatically with headcount.</Text>
              </View>

              <View style={styles.card}>
                <Text style={styles.cardTitle}>Daily Email Settings</Text>
                <View style={styles.row}><Text style={{ width: 120 }}>Send to</Text><TextInput value={emailTo} onChangeText={setEmailTo} autoCapitalize='none' keyboardType='email-address' style={[styles.input, { flex: 1 }]} /></View>
                <View style={styles.row}><Text style={{ width: 120 }}>Send hour</Text><TextInput value={String(sendHour)} onChangeText={setSendHour} keyboardType='number-pad' style={[styles.input, { width: 100 }]} /><Text style={{ marginLeft: 8 }}>(0-23, local time)</Text></View>
                <View style={styles.row}><Text style={{ width: 120 }}>Webhook URL</Text><TextInput value={emailWebhook} onChangeText={setEmailWebhook} autoCapitalize='none' placeholder='https://your-api.example/send' style={[styles.input, { flex: 1 }]} /></View>
                <View style={[styles.row, { justifyContent: 'flex-start', gap: 8 }]}>
                  <TouchableOpacity style={[styles.btn, { backgroundColor: '#10b981' }]} onPress={sendDailyEmailNow}><Text style={styles.btnText}>Send test email now</Text></TouchableOpacity>
                </View>
                <Text style={{ color: '#6b7280', marginTop: 6 }}>Note: iOS/Android may throttle background fetch. Keeping the app opened daily improves reliability. For guaranteed delivery, use a server-side schedule and let the app push data to it.</Text>
              </View>

              <View style={styles.row}> 
                <TouchableOpacity style={[styles.btn, { backgroundColor: '#0ea5e9' }]} onPress={exportCSV}><Text style={styles.btnText}>Export CSV</Text></TouchableOpacity>
                <TouchableOpacity style={[styles.btn, { backgroundColor: '#0ea5e9' }]} onPress={exportJSON}><Text style={styles.btnText}>Export JSON</Text></TouchableOpacity>
                <TouchableOpacity style={[styles.btn, { backgroundColor: '#ef4444' }]} onPress={resetMonth}><Text style={styles.btnText}>Reset Month</Text></TouchableOpacity>
                <TouchableOpacity style={[styles.btn, { backgroundColor: '#10b981' }]} onPress={() => setImportVisible(true)}><Text style={styles.btnText}>Import JSON</Text></TouchableOpacity>
              </View>
            </View>
          )}

          {activeTab === 'tests' && (
            <View style={{ marginTop: 12 }}>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>In-App Tests</Text>
                <TouchableOpacity style={styles.btn} onPress={runTests}><Text style={styles.btnText}>Run Tests</Text></TouchableOpacity>
                {tests.length === 0 ? (
                  <Text style={{ color: '#6b7280', marginTop: 8 }}>No tests run yet.</Text>
                ) : (
                  tests.map((r, idx) => (
                    <View key={idx} style={[styles.rowBetween, { paddingVertical: 8, borderBottomWidth: 1, borderColor: '#eee' }]}> 
                      <Text style={{ fontWeight: '600' }}>{r.name}</Text>
                      <Text style={{ color: r.pass ? '#16a34a' : '#ef4444' }}>{r.pass ? 'PASS' : `FAIL: ${r.details}`}</Text>
                    </View>
                  ))
                )}
                <Text style={{ color: '#6b7280', fontSize: 12, marginTop: 8 }}>Note: On devices restricting storage, the persistence test may be inconclusive.</Text>
              </View>
            </View>
          )}

          {/* Import Modal */}
          <Modal visible={importVisible} animationType="slide" transparent>
            <View style={styles.modalBackdrop}>
              <View style={styles.modalCard}>
                <Text style={{ fontWeight: '700', fontSize: 16, marginBottom: 8 }}>Import Month JSON</Text>
                <TextInput style={[styles.input, { height: 140, textAlignVertical: 'top' }]} multiline placeholder='{"month":"2025-08","targets":{...},"associates":[...]}' value={importText} onChangeText={setImportText} />
                <View style={styles.rowBetween}>
                  <TouchableOpacity style={[styles.btn, { backgroundColor: '#6b7280' }]} onPress={() => setImportVisible(false)}><Text style={styles.btnText}>Cancel</Text></TouchableOpacity>
                  <TouchableOpacity style={styles.btn} onPress={importJSON}><Text style={styles.btnText}>Import</Text></TouchableOpacity>
                </View>
              </View>
            </View>
          </Modal>

          <Text style={{ textAlign: 'center', color: '#6b7280', marginTop: 16, marginBottom: 24 }}>
            Built for monthly targets: Connects 800 • Geo Data 50 • Buyer Appointments 20 • Market Appraisals 25 • Listings Generated 1
          </Text>
        </ScrollView>
      </SafeAreaView>
    </ErrorBoundary>
  );
}

/*********************
 * Styles            *
 *********************/
const styles = StyleSheet.create({
  card: { backgroundColor: '#fff', borderRadius: 16, padding: 12, borderWidth: 1, borderColor: '#eee', marginTop: 12 },
  cardTitle: { fontWeight: '700', fontSize: 16 },
  progressOuter: { height: 8, backgroundColor: '#e5e7eb', borderRadius: 999, marginTop: 8 },
  progressInner: { height: 8, backgroundColor: '#3b82f6', borderRadius: 999 },
  tabBtn: { paddingVertical: 8, paddingHorizontal: 12, borderWidth: 1, borderColor: '#e5e7eb', borderTopLeftRadius: 12, borderTopRightRadius: 12, marginRight: 8, backgroundColor: '#f9fafb' },
  tabBtnActive: { backgroundColor: '#fff', borderBottomColor: '#fff' },
  tabText: { color: '#6b7280', fontWeight: '600' },
  tabTextActive: { color: '#111827' },
  chip: { paddingVertical: 6, paddingHorizontal: 10, backgroundColor: '#f3f4f6', borderRadius: 999, marginRight: 8 },
  chipActive: { backgroundColor: '#111827' },
  chipText: { color: '#111827' },
  chipTextActive: { color: '#fff' },
  input: { borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: '#fff' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  tableHeader: { backgroundColor: '#f9fafb', paddingHorizontal: 12, paddingVertical: 10 },
  tableRow: { paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1, borderColor: '#f3f4f6' },
  th: { width: 120, fontWeight: '700' },
  thShort: { width: 80, textAlign: 'right', fontWeight: '700' },
  td: { fontSize: 14 },
  tdShort: { width: 60, textAlign: 'right' },
  inputTd: { width: 80, textAlign: 'right', paddingVertical: 6 },
  btn: { backgroundColor: '#3b82f6', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 12 },
  btnText: { color: '#fff', fontWeight: '700' },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 16 },
  modalCard: { backgroundColor: '#fff', padding: 16, borderRadius: 16 },
});
