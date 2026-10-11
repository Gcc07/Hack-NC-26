/* Meadow — iMessage via the local Spectrum bridge (meadow/).
 *
 * The bridge texts members (reminders that double as "still good?" checks, availability polls,
 * post-event surveys) and turns their replies into updates. This module queues those texts and
 * folds the replies back into the store: poll tallies, plan statuses, survey answers, role releases.
 * Every text is triggered by an officer, and a role is only released after the member texts YES.
 */
(function () {
  const M = window.Meadow;
  const S = () => M.store.get();
  const base = () => ((window.MEADOW_CONFIG && window.MEADOW_CONFIG.IMESSAGE_BRIDGE_URL) || '').replace(/\/$/, '');
  const I = (M.imsg = { status: 'off', mode: null, error: null });

  async function api(path, body) {
    const r = await fetch(base() + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `iMessage bridge error (${r.status})`);
    return j;
  }

  I.enabled = () => !!base();
  I.up = () => I.status === 'up';
  I.canText = (u) => !!(u && u.phone && u.imessageOptIn);
  I.reachable = (state, ids) => ids.filter((id) => I.canText(state.users[id]));
  I.statusLabel = () =>
    !I.enabled() ? 'not configured' : I.status === 'up' ? (I.mode === 'dry' ? 'online (dry run — texts print in the bridge terminal)' : I.mode === 'live' ? 'online' : 'connecting…') : 'offline';

  const eventInfo = (ev) => ({ id: ev.id, orgId: ev.orgId, title: ev.title, start: ev.start, end: ev.end, location: ev.location || '' });
  const requireUp = async () => {
    if (!I.up()) await health();
    if (!I.up()) throw new Error('The iMessage bridge is offline. Start it with: cd meadow && npm start');
  };
  const say = (channel, text, payload) => M.store.update((s) => M.act._say(s, channel, text, payload));
  const skippedNote = (n) => (n ? ` ${M.plural(n, 'person', 'people')} haven't turned on iMessage under Me, so they weren't texted.` : '');

  /* ------------------------------------------------------------------ member opt-in */
  I.savePhone = async function (uid, phone, optIn) {
    phone = String(phone || '').trim().slice(0, 40);
    if (optIn && !phone) throw new Error('Add your phone number first.');
    const u = S().users[uid];
    if (optIn) {
      await requireUp();
      const res = await api('/contacts', { userId: uid, name: u.name, phone, orgIds: M.myOrgs(uid).map((o) => o.id) });
      phone = res.phone;
    } else if (I.up()) {
      await api('/contacts/remove', { userId: uid }).catch(() => {});
    }
    M.store.update((s) => {
      s.users[uid].phone = phone;
      s.users[uid].imessageOptIn = !!optIn;
      delete s.users[uid].imessageError;
    });
  };

  /* ------------------------------------------------------------------ officer actions */
  function eventTargets(state, ev, roleFilter) {
    const withRoles = new Map();
    const filter = Array.isArray(roleFilter) && roleFilter.length ? new Set(roleFilter) : null;
    ev.roles.forEach((r) => {
      if (filter && !filter.has(r.name)) return;
      r.claims.forEach((id) => withRoles.set(id, [...(withRoles.get(id) || []), r.name]));
    });
    // No role claims (or no roles on the event): fall back to the whole org, unless a role filter was set.
    const ids = withRoles.size
      ? [...withRoles.keys()]
      : filter
        ? []
        : Object.keys(state.orgs[ev.orgId].members);
    return ids.map((id) => ({ userId: id, roleNames: withRoles.get(id) || [] }));
  }
  I.eventTargets = eventTargets;

  /** Who gets the post-event survey: everyone who checked in or held a role (else the whole org). */
  I.surveyTargets = function (state, ev) {
    const went = new Set([...(ev.attendance || []), ...ev.roles.flatMap((r) => r.claims)]);
    return went.size ? [...went] : Object.keys(state.orgs[ev.orgId].members);
  };

  /**
   * RSVP reminder — standard Dewey copy or a custom message; send now or at sendAt.
   * Third arg may be `true` (send now) or options:
   *   { now, sendAt, text, askRsvp, kind, roleFilter }
   */
  I.sendReminders = async function (ev, actorId, nowOrOpts, roleFilter) {
    await requireUp();
    const state = S();
    if (!M.isOfficer(state.orgs[ev.orgId], actorId)) throw new Error('Only officers can text reminders.');
    const opts =
      nowOrOpts && typeof nowOrOpts === 'object'
        ? nowOrOpts
        : { now: !!nowOrOpts, roleFilter };
    const kind = opts.kind || 'roles';
    const filter = opts.roleFilter !== undefined ? opts.roleFilter : roleFilter;
    const all =
      kind === 'roles'
        ? eventTargets(state, ev, filter)
        : I.participantIds(state, ev, kind, filter).map((userId) => ({ userId, roleNames: [] }));
    const targets = all.filter((t) => I.canText(state.users[t.userId]));
    if (!targets.length) {
      if (all.length) throw new Error('People are listed, but none have turned on iMessage under Me yet.');
      throw new Error(filter && filter.length
        ? 'Nobody has claimed the selected roles yet.'
        : 'Nobody in that group has turned on iMessage yet.');
    }
    const text = typeof opts.text === 'string' ? opts.text.trim().slice(0, 500) : '';
    const sendAt =
      typeof opts.sendAt === 'number' && Number.isFinite(opts.sendAt) ? opts.sendAt : 0;
    const now = opts.now !== false && (!sendAt || sendAt <= Date.now() + 2000);
    const body = {
      event: eventInfo(ev),
      recipients: targets,
      now: !!now,
      askRsvp: opts.askRsvp !== false,
    };
    if (text) body.text = text;
    if (!now && sendAt) body.sendAt = sendAt;
    const res = await api('/reminders', body);
    if (!res.scheduled) {
      M.store.update((s) => {
        const e = s.events[ev.id];
        e.imessage = e.imessage || {};
        e.imessage.reminded = [...new Set([...(e.imessage.reminded || []), ...targets.map((t) => t.userId)])];
        e.imessage.remindedAt = Date.now();
      });
    } else {
      M.store.update((s) => {
        const e = s.events[ev.id];
        e.imessage = e.imessage || {};
        e.imessage.scheduledReminders = [
          ...(e.imessage.scheduledReminders || []),
          { jobId: res.jobId, sendAt: res.sendAt, count: targets.length, custom: !!text, ts: Date.now() },
        ];
      });
    }
    const roleNames = [...new Set(targets.flatMap((t) => t.roleNames))];
    const roleBit = roleNames.length ? ` with ${roleNames.join(' / ')}` : '';
    const style = text ? 'custom' : 'standard';
    const what = res.scheduled
      ? `will get a ${style} reminder at ${M.fmt.day(res.sendAt)}, ${M.fmt.time(res.sendAt)}`
      : `got a ${style} RSVP reminder`;
    say(
      'event:' + ev.id,
      `📱 ${M.plural(res.scheduled ? targets.length : res.reached, 'person', 'people')}${roleBit} ${what} by iMessage.` +
        skippedNote(res.skipped.length) +
        (opts.askRsvp === false ? '' : ' Replies (in / running late / can’t make it) show up here.')
    );
    return res;
  };

  I.sendSurvey = async function (ev, actorId) {
    await requireUp();
    const state = S();
    if (!M.isOfficer(state.orgs[ev.orgId], actorId)) throw new Error('Only officers can send surveys.');
    const reach = I.reachable(state, I.surveyTargets(state, ev));
    if (!reach.length) throw new Error('Nobody who went to this event has turned on iMessage yet.');
    const surveyId = 'sv_' + ev.id;
    const sendAt = ev.end > Date.now() ? ev.end + 30 * M.MIN : Date.now();
    const res = await api('/surveys', { surveyId, event: eventInfo(ev), recipients: reach.map((userId) => ({ userId })), sendAt });
    M.store.update((s) => {
      const prev = s.surveys[surveyId];
      s.surveys[surveyId] = { id: surveyId, eventId: ev.id, orgId: ev.orgId, sentTo: [...new Set([...(prev ? prev.sentTo : []), ...reach])], sendAt, responses: prev ? prev.responses : {} };
    });
    return res;
  };

  /**
   * Who can receive an officer text for this event.
   * kind: roles | going | reminded | org
   * roleFilter: optional role names when kind === 'roles'
   */
  I.participantIds = function (state, ev, kind, roleFilter) {
    const org = state.orgs[ev.orgId];
    if (!org) return [];
    if (kind === 'org') return Object.keys(org.members);
    if (kind === 'reminded') return (ev.imessage && ev.imessage.reminded) || [];
    if (kind === 'going') {
      const plans = ev.plans || {};
      return Object.keys(plans).filter((id) => plans[id].status === 'going' || plans[id].status === 'late');
    }
    // roles (default)
    return eventTargets(state, ev, roleFilter).map((t) => t.userId);
  };

  /** Freeform officer broadcast to opted-in participants. */
  I.sendText = async function (ev, actorId, text, kind, roleFilter) {
    await requireUp();
    const state = S();
    if (!M.isOfficer(state.orgs[ev.orgId], actorId)) throw new Error('Only officers can text participants.');
    text = String(text || '').trim().slice(0, 500);
    if (!text) throw new Error('Write a message first.');
    const ids = I.participantIds(state, ev, kind || 'roles', roleFilter);
    const reach = I.reachable(state, ids);
    if (!reach.length) throw new Error('Nobody in that group has iMessage turned on under Me.');
    const res = await api('/broadcast', {
      event: eventInfo(ev),
      recipients: reach.map((userId) => ({ userId })),
      text,
    });
    const skipped = ids.length - reach.length;
    say(
      'event:' + ev.id,
      `📱 Officer texted ${M.plural(res.reached, 'person', 'people')}: “${text.slice(0, 120)}${text.length > 120 ? '…' : ''}”` +
        skippedNote(Math.max(0, skipped))
    );
    return res;
  };

  /** Text the top suggested times to the whole org and tally replies live in the chat. */
  I.pollAvailability = async function (org, title, results, actorId) {
    await requireUp();
    const state = S();
    if (!M.isOfficer(org, actorId)) throw new Error('Only officers can poll members.');
    const options = results.slice(0, 3).map((r) => ({ label: `${M.fmt.day(r.start)}, ${M.fmt.time(r.start)}–${M.fmt.time(r.end)}`, start: r.start, end: r.end }));
    const reach = I.reachable(state, Object.keys(org.members));
    if (!reach.length) throw new Error('Nobody in this org has turned on iMessage yet.');
    const pollId = M.uid('p');
    title = String(title || 'our next event').slice(0, 80);
    const res = await api('/availability', { pollId, orgId: org.id, title, options, recipients: reach.map((userId) => ({ userId })) });
    M.store.update((s) => {
      s.polls[pollId] = { id: pollId, orgId: org.id, title, options, sentTo: reach, responses: {}, createdBy: actorId, createdAt: Date.now() };
      M.act._say(s, 'org:' + org.id, `📱 I texted ${M.plural(res.reached, 'member')} asking which times work for **${title}**. Replies tally here live.` + skippedNote(res.skipped.length), { type: 'poll', pollId });
    });
    return res;
  };

  const deleteAccount = M.act.deleteAccount;
  M.act.deleteAccount = function (uid) {
    if (I.up()) api('/contacts/remove', { userId: uid }).catch(() => {});
    deleteAccount(uid);
  };

  // A cancellation is texted to everyone who was reminded, so nobody shows up to an empty room.
  const cancelEvent = M.act.cancelEvent;
  M.act.cancelEvent = function (eventId, actorId) {
    cancelEvent(eventId, actorId);
    const ev = S().events[eventId];
    const reminded = (ev.imessage && ev.imessage.reminded) || [];
    if (!I.up() || !reminded.length) return;
    api('/broadcast', { event: eventInfo(ev), cancelled: true, recipients: reminded.map((userId) => ({ userId })), text: `🚫 ${ev.title} (${M.fmt.day(ev.start)}, ${M.fmt.time(ev.start)}) has been cancelled. Sorry for the change!` })
      .then((r) => say('event:' + ev.id, `📱 Texted the cancellation to ${M.plural(r.reached, 'person', 'people')}.`))
      .catch((e) => M.toast(e.message));
  };

  /* ------------------------------------------------------------------ replies → store */
  function applyUpdate(s, u, effects) {
    const user = s.users[u.userId];
    if (!user) return;
    const name = user.name;
    const ev = u.eventId && s.events[u.eventId];
    switch (u.type) {
      case 'availability': {
        const poll = s.polls[u.pollId];
        if (poll) poll.responses[u.userId] = { picks: u.picks, note: u.note, ts: u.ts };
        break;
      }
      case 'plans': {
        if (!ev) break;
        ev.plans = ev.plans || {};
        ev.plans[u.userId] = { status: u.status, minutes: u.minutes || null, ts: u.ts };
        const text =
          u.status === 'going' ? `✅ ${name} confirmed by iMessage — see you there.`
          : u.status === 'late' ? `🕒 ${name} texted that they’re running ${u.minutes ? `~${u.minutes} min ` : ''}late.`
          : `⚠️ ${name} texted that they can’t make it.`;
        M.act._say(s, 'event:' + ev.id, text, null, 'assistant');
        break;
      }
      case 'release':
        if (ev)
          ev.roles.filter((r) => r.claims.includes(u.userId)).forEach((r) => effects.push(() => M.act.releaseRole(ev.id, r.id, u.userId)));
        break;
      case 'survey': {
        const sv = s.surveys[u.surveyId];
        if (sv) sv.responses[u.userId] = { ...u.answers, complete: !!u.complete, ts: u.ts };
        break;
      }
      case 'message': {
        const channel = ev && s.orgs[ev.orgId] && s.orgs[ev.orgId].members[u.userId] ? 'event:' + ev.id : u.orgId && s.orgs[u.orgId] && s.orgs[u.orgId].members[u.userId] ? 'org:' + u.orgId : null;
        if (channel) effects.push(() => M.act.postMessage(channel, u.userId, u.text, { source: 'imessage' }));
        break;
      }
      case 'optout':
        user.imessageOptIn = false;
        break;
      case 'optin':
        user.imessageOptIn = true;
        break;
      case 'undeliverable':
        user.imessageError = u.error;
        effects.push(() => M.toast(`Couldn’t text ${M.firstName(name)}: ${u.error}`));
        break;
    }
  }

  async function pull() {
    const known = S().imessage || {};
    const res = await api('/updates?after=' + (known.lastSeq || 0));
    if (res.epoch !== known.epoch) {
      // Fresh bridge state: its sequence numbers start over.
      M.store.update((s) => (s.imessage = { epoch: res.epoch, lastSeq: 0 }), { silent: true });
      if (known.lastSeq) return pull();
    }
    const effects = [];
    M.store.update((s) => {
      // Another tab may have applied these already; lastSeq lives in shared storage.
      for (const u of res.updates) {
        if (u.seq <= s.imessage.lastSeq) continue;
        s.imessage.lastSeq = u.seq;
        applyUpdate(s, u, effects);
      }
    }, { silent: !res.updates.length });
    effects.forEach((fn) => M.safe(fn));
  }

  async function health() {
    if (!I.enabled()) return;
    const was = I.status;
    try {
      const h = await api('/health');
      I.status = 'up';
      I.mode = h.mode;
      I.error = h.error;
    } catch {
      I.status = 'down';
      I.mode = null;
    }
    if (was !== I.status) {
      if (I.up()) resync();
      M.render();
    }
  }

  /** Re-register this tab's person, in case the bridge restarted with fresh state. */
  function resync() {
    const me = M.me();
    if (me && I.canText(me)) api('/contacts', { userId: me.id, name: me.name, phone: me.phone, orgIds: M.myOrgs(me.id).map((o) => o.id) }).catch(() => {});
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!I.enabled()) return;
    health();
    setInterval(health, 15000);
    setInterval(() => {
      if (I.up()) pull().catch(() => {});
    }, 4000);
  });
})();
