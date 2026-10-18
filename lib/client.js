/**
 * dsh-windows-toast — browser half.
 *
 * Renders this plugin's page inside the Web Settings → Plugins surface.
 *
 * The controls are written here rather than imported from
 * `@deepseek-ai/dsh-client-ui-primitives`. That package is not a package on
 * disk: the shipped shell publishes it through an internal seed table, so a
 * plain-JS plugin cannot rely on it across releases. What *is* stable is the
 * pair the Plugins page hands to a `plugins.item` registration — `props.form`
 * carrying `{ state, mutate }` and `props.view` selecting summary vs page — and
 * that is all this file uses.
 *
 * Styling uses only `--dsw-alias-*` theme tokens, so a renamed token degrades
 * appearance instead of breaking rendering.
 */
window.__ModuleLoader__.load({
	id: 'dsh-windows-toast',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')
		const h = React.createElement

		// ------------------------------------------------------------- locale

		const NS = 'settings.windowsToast'

		const en = {
			title: 'Toast notifications',
			description: 'Windows toast notifications for review events.',
			loading: 'Loading current settings…',
			unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
			readOnly: 'This deployment stores settings read-only.',
			groupGeneral: 'General',
			groupBehaviour: 'Behaviour',
			groupEvents: 'Per-event timing and buttons',
			enabled: 'Enable notifications',
			enabledHint: 'Master switch for every toast this plugin shows.',
			onlyWhenUnfocused: 'Only when DSH is in the background',
			onlyWhenUnfocusedHint: 'Suppresses a toast while the DSH window already has focus.',
			approvalsAnswerFromToast: 'Let the toast answer approvals',
			approvalsAnswerFromToastHint: 'Adds Approve and Reject to an approval toast. Other notifications only offer a button that returns you to DSH.',
			notifyOnSubagents: 'Include subagent activity',
			notifyOnSubagentsHint: 'Subagent turns finish constantly; leave this off unless you want each one announced.',
			showToolName: 'Show the requested tool',
			showToolNameHint: 'Names the tool in an approval toast, for example pwsh.',
			eventLabel: 'Notify',
			eventTimeout: 'Dismiss after (seconds)',
			eventTimeoutHint: '0 keeps the notification until Windows or the user dismisses it. This bounds the notification only; it never cancels the underlying request.',
			eventActions: 'Show buttons',
			eventActionsHint: 'Off shows a plain notification with no action row.',
			kindTaskCompleted: 'Task completed',
			kindTaskFailed: 'Task failed',
			kindQuestion: 'Question / extra information',
			kindApproval: 'Approval request',
			save: 'Save',
			saving: 'Saving…',
			saved: 'Saved',
			saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
			reset: 'Restore defaults',
			overridden: 'Overridden',
		}

		const zh = {
			title: 'Toast 通知',
			description: '为审核事件发送 Windows toast 通知。',
			loading: '正在读取当前设置…',
			unavailable: '该插件当前未加载，暂时无法配置。',
			readOnly: '本部署的设置为只读。',
			groupGeneral: '总开关',
			groupBehaviour: '行为',
			groupEvents: '各类事件的消失时间与按钮',
			enabled: '启用通知',
			enabledHint: '本插件所有通知的总开关。',
			onlyWhenUnfocused: '仅当 DSH 不在前台时通知',
			onlyWhenUnfocusedHint: 'DSH 窗口已获得焦点时不再打扰你。',
			approvalsAnswerFromToast: '允许在通知上直接同意/拒绝授权',
			approvalsAnswerFromToastHint: '为授权通知加上「同意 / 拒绝」。其他通知只提供一个回到 DSH 的按钮。',
			notifyOnSubagents: '子智能体也通知',
			notifyOnSubagentsHint: '子智能体每轮都会结束，除非确实想每次都收到提示，否则保持关闭。',
			showToolName: '显示请求的工具名',
			showToolNameHint: '在授权通知里标出工具名，例如 pwsh。',
			eventLabel: '通知',
			eventTimeout: '多少秒后消失',
			eventTimeoutHint: '0 表示一直保留到 Windows 或用户将其消除。这里只约束通知本身，绝不会取消对应的请求。',
			eventActions: '显示按钮',
			eventActionsHint: '关闭后只显示纯通知，没有按钮行。',
			kindTaskCompleted: '任务完成',
			kindTaskFailed: '任务失败',
			kindQuestion: '请求补充信息',
			kindApproval: '请求授权',
			save: '保存',
			saving: '保存中…',
			saved: '已保存',
			saveFailed: '本部署没有接受这些值，已保留供你修改。',
			reset: '恢复默认',
			overridden: '已覆盖',
		}

		// ---------------------------------------------------------------- css

		// Only `--dsw-alias-*` tokens that the shipped stylesheet actually defines
		// are referenced here. A token that does not exist renders as an invalid
		// declaration, so a renamed or guessed name fails visibly rather than
		// degrading — these were read out of the shipped `index-*.css`.
		const css = [
			'.dtnRoot{display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
			'.dtnNote{color:var(--dsw-alias-label-tertiary)}',
			'.dtnGroup{display:flex;flex-direction:column;gap:10px}',
			'.dtnGroupTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-dimmed)}',
			'.dtnRow{display:flex;align-items:flex-start;gap:10px}',
			'.dtnRowText{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}',
			'.dtnLabel{color:var(--dsw-alias-label-primary)}',
			'.dtnHint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
			'.dtnSwitch{appearance:none;box-sizing:border-box;width:36px;height:20px;min-width:36px;margin:2px 0 0;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);position:relative;cursor:pointer;transition:background .15s ease,border-color .15s ease}',
			'.dtnSwitch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-switch-thumb);transition:transform .15s ease}',
			'.dtnSwitch:checked{background:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
			'.dtnSwitch:checked::after{transform:translateX(16px)}',
			'.dtnSwitch:disabled{opacity:.5;cursor:not-allowed}',
			'.dtnEvent{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:10px}',
			'.dtnEventHead{display:flex;align-items:center;justify-content:space-between;gap:10px}',
			'.dtnEventName{font-weight:500}',
			'.dtnNumber{box-sizing:border-box;width:96px;padding:4px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
			'.dtnNumber:disabled{opacity:.5;cursor:not-allowed}',
			'.dtnActions{display:flex;align-items:center;gap:8px;justify-content:flex-end}',
			'.dtnButton{padding:5px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}',
			'.dtnButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
			'.dtnButton:disabled{opacity:.5;cursor:not-allowed}',
			'.dtnPrimary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
			'.dtnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
			'.dtnStatus{color:var(--dsw-alias-label-tertiary);font-size:12px}',
			'.dtnError{color:var(--dsw-alias-state-error-primary);font-size:12px}',
		].join('')

		const TAG_ID = 'dsh-windows-toast/page.css'
		if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(TAG_ID) + ']') === null) {
			const tag = document.createElement('style')
			tag.dataset.plugin = 'dsh-windows-toast'
			tag.dataset.pluginCss = TAG_ID
			tag.textContent = css
			document.head.appendChild(tag)
		}

		// ------------------------------------------------------------ helpers

		/** The kind keys, matching the Host's `events` object. */
		const KINDS = ['task-completed', 'task-failed', 'question', 'approval']

		const KIND_LABEL = {
			'task-completed': 'kindTaskCompleted',
			'task-failed': 'kindTaskFailed',
			question: 'kindQuestion',
			approval: 'kindApproval',
		}

		/** Top-level knobs, in render order. */
		const GENERAL_KEYS = ['enabled']
		const BEHAVIOUR_KEYS = ['onlyWhenUnfocused', 'approvalsAnswerFromToast', 'notifyOnSubagents', 'showToolName']

		/**
		 * Read one setting out of a form snapshot, falling back to a default.
		 * @param value - `state.value` from the form snapshot.
		 * @param path - the field path.
		 * @param fallback - the value used when the field is absent.
		 * @returns the resolved value.
		 */
		function readPath(value, path, fallback) {
			let cursor = value
			for (const key of path) {
				if (cursor === null || typeof cursor !== 'object') return fallback
				cursor = cursor[key]
			}
			return cursor === undefined ? fallback : cursor
		}

		/** One labelled switch. */
		function Switch(props) {
			const { label, hint, checked, disabled, onChange } = props
			return h('div', { className: 'dtnRow' }, [
				h('input', {
					key: 'input',
					type: 'checkbox',
					className: 'dtnSwitch',
					checked: checked === true,
					disabled: disabled === true,
					onChange: (event) => { onChange(event.target.checked) },
				}),
				h('div', { key: 'text', className: 'dtnRowText' }, [
					h('span', { key: 'label', className: 'dtnLabel' }, label),
					hint === undefined ? null : h('span', { key: 'hint', className: 'dtnHint' }, hint),
				]),
			])
		}

		/** One labelled integer field. */
		function NumberField(props) {
			const { label, hint, value, disabled, onChange } = props
			return h('div', { className: 'dtnRow' }, [
				h('div', { key: 'text', className: 'dtnRowText' }, [
					h('span', { key: 'label', className: 'dtnLabel' }, label),
					hint === undefined ? null : h('span', { key: 'hint', className: 'dtnHint' }, hint),
				]),
				h('input', {
					key: 'input',
					type: 'number',
					min: 0,
					max: 86400,
					step: 1,
					className: 'dtnNumber',
					value: String(value),
					disabled: disabled === true,
					onChange: (event) => {
						const parsed = Number.parseInt(event.target.value, 10)
						onChange(Number.isFinite(parsed) ? Math.min(86400, Math.max(0, parsed)) : 0)
					},
				}),
			])
		}

		/**
		 * One event kind's block: enable, dismiss time, and buttons.
		 */
		function EventBlock(props) {
			const { t, kind, value, disabled, onChange } = props
			return h('div', { className: 'dtnEvent' }, [
				h('div', { key: 'head', className: 'dtnEventHead' }, [
					h('span', { key: 'name', className: 'dtnEventName' }, t(KIND_LABEL[kind])),
					h(Switch, {
						key: 'switch',
						label: t('eventLabel'),
						checked: readPath(value, ['events', kind, 'enabled'], false),
						disabled,
						onChange: (next) => { onChange(['events', kind, 'enabled'], next) },
					}),
				]),
				h(NumberField, {
					key: 'timeout',
					label: t('eventTimeout'),
					hint: t('eventTimeoutHint'),
					value: readPath(value, ['events', kind, 'timeoutSeconds'], 0),
					disabled,
					onChange: (next) => { onChange(['events', kind, 'timeoutSeconds'], next) },
				}),
				h(Switch, {
					key: 'actions',
					label: t('eventActions'),
					hint: t('eventActionsHint'),
					checked: readPath(value, ['events', kind, 'actions'], true),
					disabled,
					onChange: (next) => { onChange(['events', kind, 'actions'], next) },
				}),
			])
		}

		/**
		 * The editable page.
		 *
		 * `props.form.state` is the accepted namespace value plus its revision, and
		 * `props.form.mutate` submits one atomic operation list. Edits are staged
		 * locally so a refused write leaves the user's draft intact.
		 */
		function WindowsToastForm(props) {
			const { t, form } = props
			const state = form?.state
			const [draft, setDraft] = React.useState(null)
			const [busy, setBusy] = React.useState(false)
			const [failed, setFailed] = React.useState(false)
			const [saved, setSaved] = React.useState(false)

			// Adopt accepted values once they arrive, so an edit made elsewhere is
			// never silently clobbered once the user has a draft of their own.
			const revision = state?.revision
			React.useEffect(() => {
				if (state?.value === undefined) return
				setDraft((current) => (current === null ? state.value : current))
				setFailed(false)
			}, [revision])

			if (state === undefined || state.status === 'loading') {
				return h('div', { className: 'dtnRoot' }, h('span', { className: 'dtnNote' }, t('loading')))
			}
			if (state.status === 'unavailable' || state.value === undefined) {
				return h('div', { className: 'dtnRoot' }, h('span', { className: 'dtnNote' }, t('unavailable')))
			}

			const value = draft ?? state.value
			const disabled = state.writable !== true

			const setPath = (path, next) => {
				setSaved(false)
				setDraft((current) => {
					const base = current ?? state.value
					const clone = { ...base, events: { ...(base.events ?? {}) } }
					if (path.length === 1) clone[path[0]] = next
					else {
						const [group, kind, field] = path
						clone[group] = { ...(clone[group] ?? {}) }
						clone[group][kind] = { ...(clone[group][kind] ?? {}) }
						clone[group][kind][field] = next
					}
					return clone
				})
			}

			/** Diff the draft against the accepted value into one atomic op list. */
			const collectOps = () => {
				const ops = []
				for (const key of [...GENERAL_KEYS, ...BEHAVIOUR_KEYS]) {
					const before = readPath(state.value, [key], undefined)
					const after = readPath(value, [key], undefined)
					if (after !== before) ops.push({ op: 'set', path: [key], value: after })
				}
				for (const kind of KINDS) {
					// The whole block, so a first-ever write creates it in one step.
					const before = readPath(state.value, ['events', kind], undefined)
					const after = readPath(value, ['events', kind], undefined)
					if (JSON.stringify(after) !== JSON.stringify(before)) {
						ops.push({ op: 'set', path: ['events', kind], value: after })
					}
				}
				return ops
			}

			const dirty = collectOps().length > 0

			const apply = async (ops) => {
				if (ops.length === 0) return
				setBusy(true)
				setFailed(false)
				try {
					if (await form.mutate(ops, state.revision)) {
						setSaved(true)
						setDraft(null)
					} else setFailed(true)
				} catch {
					setFailed(true)
				} finally {
					setBusy(false)
				}
			}

			const reset = () => apply([
				...[...GENERAL_KEYS, ...BEHAVIOUR_KEYS].map((key) => ({ op: 'unset', path: [key] })),
				...KINDS.map((kind) => ({ op: 'unset', path: ['events', kind] })),
			])

			const switchRow = (key, label, hint) => h(Switch, {
				key,
				label: t(label),
				hint: t(hint),
				checked: readPath(value, [key], false),
				disabled: disabled || busy,
				onChange: (next) => { setPath([key], next) },
			})

			return h('div', { className: 'dtnRoot' }, [
				disabled ? h('div', { key: 'ro', className: 'dtnNote' }, t('readOnly')) : null,

				h('div', { key: 'general', className: 'dtnGroup' }, [
					h('div', { key: 'title', className: 'dtnGroupTitle' }, t('groupGeneral')),
					switchRow('enabled', 'enabled', 'enabledHint'),
				]),

				h('div', { key: 'behaviour', className: 'dtnGroup' }, [
					h('div', { key: 'title', className: 'dtnGroupTitle' }, t('groupBehaviour')),
					switchRow('onlyWhenUnfocused', 'onlyWhenUnfocused', 'onlyWhenUnfocusedHint'),
					switchRow('approvalsAnswerFromToast', 'approvalsAnswerFromToast', 'approvalsAnswerFromToastHint'),
					switchRow('showToolName', 'showToolName', 'showToolNameHint'),
					switchRow('notifyOnSubagents', 'notifyOnSubagents', 'notifyOnSubagentsHint'),
				]),

				h('div', { key: 'events', className: 'dtnGroup' }, [
					h('div', { key: 'title', className: 'dtnGroupTitle' }, t('groupEvents')),
					...KINDS.map((kind) => h(EventBlock, {
						key: kind,
						t,
						kind,
						value,
						disabled: disabled || busy,
						onChange: setPath,
					})),
				]),

				h('div', { key: 'actions', className: 'dtnActions' }, [
					failed ? h('span', { key: 'failed', className: 'dtnError' }, t('saveFailed')) : null,
					!failed && saved && !dirty ? h('span', { key: 'saved', className: 'dtnStatus' }, t('saved')) : null,
					h('button', {
						key: 'reset',
						type: 'button',
						className: 'dtnButton',
						disabled: disabled || busy,
						onClick: reset,
					}, t('reset')),
					h('button', {
						key: 'save',
						type: 'button',
						className: 'dtnButton dtnPrimary',
						disabled: disabled || busy || !dirty,
						onClick: () => apply(collectOps()),
					}, busy ? t('saving') : t('save')),
				]),
			])
		}

		// ---------------------------------------------------------------- reveal

		/**
		 * Route the Host half publishes toast-click navigation on. Spelled here
		 * rather than imported, for the same reason as `SETTINGS_NS`: a client
		 * package must not depend on a Host package.
		 */
		const NAVIGATION_PATH = '/dsh-windows-toast/pending-navigation'

		/** How often to ask. A click is not urgent, but it should feel immediate. */
		const NAVIGATION_POLL_MS = 1500

		/**
		 * Reveal whichever session a toast click asked for.
		 *
		 * DSH has no deep link into a session — selection is browser-local state,
		 * and the `dsh://` protocol the desktop registers only focuses the window
		 * — so the click is carried across on a route the Host half publishes and
		 * this poll collects. `uiWorkspace.openSession` is the one API that
		 * selects a session; it is read without an inject requirement, because a
		 * profile may compose no workspace UI at all.
		 * @param ctx - the browser plugin context.
		 * @returns the disposer stopping the poll.
		 */
		function watchNavigation(ctx) {
			let disposed = false
			let inFlight = false

			const openSession = (sessionId) => {
				try {
					const workspace = ctx.get('uiWorkspace')
					if (typeof workspace?.openSession !== 'function') return false
					// `openSession` itself returns the main area to the Conversation and
					// clears any global panel, so no further call is needed here.
					workspace.openSession(sessionId)
					return true
				} catch {
					return false
				}
			}

			const tick = () => {
				// A slow or hung request must not stack up behind the interval.
				if (disposed || inFlight) return
				inFlight = true
				fetch(NAVIGATION_PATH, { cache: 'no-store', credentials: 'same-origin' })
					.then((response) => (response.ok ? response.json() : undefined))
					.then((payload) => {
						const ids = Array.isArray(payload?.sessionIds) ? payload.sessionIds : []
						// Last wins: a click that arrived later is the more recent intent.
						for (const id of ids) if (typeof id === 'string' && id !== '') openSession(id)
					})
					.catch(() => {})
					.finally(() => {
						inFlight = false
					})
			}

			tick()
			const timer = setInterval(tick, NAVIGATION_POLL_MS)
			timer.unref?.()
			// A click raises the window, so focus arrives with the request already
			// waiting. Checking immediately makes the reveal feel instant instead of
			// waiting out the interval, and the interval remains the fallback for a
			// click that lands while the window is already focused.
			const onFocus = () => tick()
			try {
				window.addEventListener('focus', onFocus)
			} catch {}
			return () => {
				disposed = true
				clearInterval(timer)
				try {
					window.removeEventListener('focus', onFocus)
				} catch {}
			}
		}

		/**
		 * Slot entry point. The slot is rendered once with `view: "summary"` for the
		 * card line and once with `view: "page"` for the detail page, so the two are
		 * separate components: branching inside one component would call hooks
		 * conditionally.
		 */
		function WindowsToastPage(props) {
			if (props.view === 'summary') return props.t('description')
			return h(WindowsToastForm, { t: props.t, form: props.form })
		}

		// ---------------------------------------------------------------- apply

		/**
		 * Namespace this page configures. Spelled here rather than imported: a
		 * client package must not depend on a Host package, and it must match the
		 * `id` this bundle's `cordis.patch.yml` inserts.
		 */
		const SETTINGS_NS = 'dsh-windows-toast'

		const inject = ['slots', 'locale', 'configForms']

		/**
		 * Register the page while the Host serves this plugin's namespace, so a
		 * deployment that never loaded the Host half shows no trace of it.
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			const t = ctx.locale.bind(NS)
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-windows-toast: dictionaries')
			ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
				name: 'plugins.item',
				id: SETTINGS_NS,
				order: 40,
				label: () => t('title'),
				locale: NS,
			}, WindowsToastPage))), 'dsh-windows-toast: settings page')
			// Independent of the settings page: a user who never opens settings
			// still expects a toast click to land on the right session.
			ctx.effect(() => watchNavigation(ctx), 'dsh-windows-toast: toast-click navigation')
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
