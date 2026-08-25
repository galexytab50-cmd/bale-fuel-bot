/**
 * بات بله - محاسبه‌گر صرفه‌جویی سوخت
 * ------------------------------------
 * این فایل به‌صورت webhook کار می‌کنه (نه polling)، چون Cloudflare Workers
 * یک محیط request/response هست و نمی‌تونه به‌صورت دائم در پس‌زمینه اجرا بمونه.
 *
 * وضعیت مکالمه هر کاربر (اینکه توی چه مرحله‌ایه) داخل Cloudflare KV ذخیره
 * می‌شه، چون Worker خودش هیچ حافظه‌ای بین درخواست‌ها نداره.
 */

export interface Env {
	BALE_TOKEN: string;
	DB: D1Database;
	/** اختیاری: اگه ست بشه، درخواست‌های webhook با این توکن راستی‌آزمایی می‌شن */
	WEBHOOK_SECRET?: string;
}

// ---------------------------------------------------------------------------
// انواع داده (بخش مورد نیاز از ساختار آپدیت‌های بله/تلگرام)
// ---------------------------------------------------------------------------

interface BaleUpdate {
	update_id: number;
	message?: BaleMessage;
}

interface BaleMessage {
	message_id: number;
	chat: { id: number };
	text?: string;
}

// ---------------------------------------------------------------------------
// داده‌های خودرو - TODO: با اعداد واقعی مصرف پر بشه
// ---------------------------------------------------------------------------

const CAR_MODELS: string[] = [
	'پراید ۱۳۱', 'پراید ۱۳۲',
	'سمند', 'پژو ۴۰۵',
	'دنا', 'تارا',
	'ساینا', 'تیبا',
	'ران', 'هایما',
	'برلیانس', 'کوئیک',
	'شاهین', 'سایر خودروها',
];

interface CarInfo {
	petrolPer100km: number | null;
	gasPer100km: number | null;
}

// TODO: این جدول رو با اعداد واقعی مصرف هر خودرو پر کن
// واحد پیشنهادی: لیتر بنزین / متر مکعب گاز به ازای هر ۱۰۰ کیلومتر
const CAR_DATA: Record<string, CarInfo> = Object.fromEntries(
	CAR_MODELS.map((car) => [car, { petrolPer100km: null, gasPer100km: null }])
);

// TODO: این ضرایب رو با مقادیر واقعی سایت جایگزین کن
const DRIVING_STYLE_FACTOR: Record<string, number> = {
	'آرام': 0.9,
	'معمولی': 1.0,
	'تند': 1.15,
};

// TODO: قیمت واقعی هر لیتر بنزین و هر متر مکعب گاز (تومان)
const PETROL_PRICE_PER_LITER: number | null = null;
const GAS_PRICE_PER_M3: number | null = null;

// ---------------------------------------------------------------------------
// مدیریت وضعیت مکالمه (State Machine) - داخل D1 ذخیره می‌شه
// ---------------------------------------------------------------------------

type Step = 'car' | 'daily_km' | 'days_per_week' | 'driving_style';

interface ConversationState {
	step: Step;
	car?: string;
	dailyKm?: number;
	daysPerWeek?: number;
	drivingStyle?: string;
}

interface ConversationRow {
	chat_id: number;
	step: Step;
	car: string | null;
	daily_km: number | null;
	days_per_week: number | null;
	driving_style: string | null;
}

async function getState(env: Env, chatId: number): Promise<ConversationState | null> {
	const row = await env.DB.prepare('SELECT step, car, daily_km, days_per_week, driving_style FROM conversation_state WHERE chat_id = ?')
		.bind(chatId)
		.first<ConversationRow>();

	if (!row) return null;

	return {
		step: row.step,
		car: row.car ?? undefined,
		dailyKm: row.daily_km ?? undefined,
		daysPerWeek: row.days_per_week ?? undefined,
		drivingStyle: row.driving_style ?? undefined,
	};
}

async function setState(env: Env, chatId: number, state: ConversationState): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO conversation_state (chat_id, step, car, daily_km, days_per_week, driving_style, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(chat_id) DO UPDATE SET
		   step = excluded.step,
		   car = excluded.car,
		   daily_km = excluded.daily_km,
		   days_per_week = excluded.days_per_week,
		   driving_style = excluded.driving_style,
		   updated_at = excluded.updated_at`
	)
		.bind(
			chatId,
			state.step,
			state.car ?? null,
			state.dailyKm ?? null,
			state.daysPerWeek ?? null,
			state.drivingStyle ?? null,
			Date.now()
		)
		.run();
}

async function clearState(env: Env, chatId: number): Promise<void> {
	await env.DB.prepare('DELETE FROM conversation_state WHERE chat_id = ?').bind(chatId).run();
}

// ---------------------------------------------------------------------------
// ارتباط با Bale API (سازگار با Telegram Bot API)
// ---------------------------------------------------------------------------

function baleApiUrl(env: Env, method: string): string {
	return `https://tapi.bale.ai/bot${env.BALE_TOKEN}/${method}`;
}

interface Keyboard {
	keyboard: string[][];
	resize_keyboard?: boolean;
	one_time_keyboard?: boolean;
}

async function sendMessage(
	env: Env,
	chatId: number,
	text: string,
	keyboard?: Keyboard | 'remove'
): Promise<void> {
	const body: Record<string, unknown> = {
		chat_id: chatId,
		text,
	};

	if (keyboard === 'remove') {
		body.reply_markup = { remove_keyboard: true };
	} else if (keyboard) {
		body.reply_markup = keyboard;
	}

	const res = await fetch(baleApiUrl(env, 'sendMessage'), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		console.error('خطا در ارسال پیام به بله:', res.status, await res.text());
	}
}

function makeKeyboard(rows: string[][]): Keyboard {
	return { keyboard: rows, resize_keyboard: true, one_time_keyboard: true };
}

function carKeyboardRows(): string[][] {
	// خودروها رو دو‌تا دو‌تا تو هر ردیف می‌چینیم
	const rows: string[][] = [];
	for (let i = 0; i < CAR_MODELS.length; i += 2) {
		rows.push(CAR_MODELS.slice(i, i + 2));
	}
	return rows;
}

// ---------------------------------------------------------------------------
// فرمول محاسبه (باید با فرمول واقعی سایت جایگزین بشه)
// ---------------------------------------------------------------------------

function calculateSavings(state: ConversationState): string {
	const { car, dailyKm, daysPerWeek, drivingStyle } = state;
	if (!car || !dailyKm || !daysPerWeek || !drivingStyle) {
		return 'خطایی پیش اومد، لطفاً دوباره با /start شروع کن.';
	}

	const carInfo = CAR_DATA[car];
	const factor = DRIVING_STYLE_FACTOR[drivingStyle] ?? 1.0;

	if (
		!carInfo ||
		carInfo.petrolPer100km === null ||
		carInfo.gasPer100km === null ||
		PETROL_PRICE_PER_LITER === null ||
		GAS_PRICE_PER_M3 === null
	) {
		return (
			`مشخصات وارد شده:\n` +
			`🚗 خودرو: ${car}\n` +
			`📏 کیلومتر روزانه: ${dailyKm}\n` +
			`📅 روزهای رانندگی در هفته: ${daysPerWeek}\n` +
			`🎯 سبک رانندگی: ${drivingStyle}\n\n` +
			`⚠️ فعلاً اعداد مصرف سوخت و قیمت‌ها در بات تنظیم نشده، ` +
			`به همین خاطر نمی‌تونم مبلغ دقیق صرفه‌جویی رو حساب کنم.\n` +
			`(این بخش بعداً با فرمول و اعداد واقعی سایت تکمیل می‌شه.)`
		);
	}

	const monthlyKm = dailyKm * daysPerWeek * 4.3; // تقریب ماهانه
	const petrolLiters = (monthlyKm / 100) * carInfo.petrolPer100km * factor;
	const gasM3 = (monthlyKm / 100) * carInfo.gasPer100km * factor;

	const petrolCost = petrolLiters * PETROL_PRICE_PER_LITER;
	const gasCost = gasM3 * GAS_PRICE_PER_M3;
	const monthlySaving = petrolCost - gasCost;

	const fmt = (n: number) => Math.round(n).toLocaleString('fa-IR');

	return (
		`🚗 خودرو: ${car}\n` +
		`📏 کیلومتر ماهانه تقریبی: ${fmt(monthlyKm)} km\n\n` +
		`⛽ هزینه بنزین: ${fmt(petrolCost)} تومان در ماه\n` +
		`🔥 هزینه گاز: ${fmt(gasCost)} تومان در ماه\n\n` +
		`💰 صرفه‌جویی تقریبی: ${fmt(monthlySaving)} تومان در ماه`
	);
}

// ---------------------------------------------------------------------------
// پردازش پیام‌های ورودی
// ---------------------------------------------------------------------------

async function handleMessage(env: Env, message: BaleMessage): Promise<void> {
	const chatId = message.chat.id;
	const text = (message.text ?? '').trim();

	// دستور شروع مکالمه
	if (text === '/start') {
		await clearState(env, chatId);
		await setState(env, chatId, { step: 'car' });
		await sendMessage(
			env,
			chatId,
			'سلام! 👋\nبا این بات می‌تونی بفهمی با تبدیل خودرو به گازسوز چقدر می‌تونی صرفه‌جویی کنی.\n\n' +
				'اول از همه، مدل خودروت رو انتخاب کن:',
			makeKeyboard(carKeyboardRows())
		);
		return;
	}

	if (text === '/cancel') {
		await clearState(env, chatId);
		await sendMessage(env, chatId, 'لغو شد. برای شروع دوباره /start رو بزن.', 'remove');
		return;
	}

	const state = await getState(env, chatId);
	if (!state) {
		await sendMessage(env, chatId, 'برای شروع، دستور /start رو بزن.');
		return;
	}

	switch (state.step) {
		case 'car': {
			if (!CAR_MODELS.includes(text)) {
				await sendMessage(env, chatId, 'لطفاً یکی از مدل‌های لیست رو انتخاب کن.', makeKeyboard(carKeyboardRows()));
				return;
			}
			state.car = text;
			state.step = 'daily_km';
			await setState(env, chatId, state);
			await sendMessage(
				env,
				chatId,
				'میانگین کیلومتر روزانه‌ای که رانندگی می‌کنی چقدره؟ (عدد بین ۵ تا ۱۵۰ رو وارد کن)',
				'remove'
			);
			return;
		}

		case 'daily_km': {
			const km = Number(text);
			if (!Number.isInteger(km) || km < 5 || km > 150) {
				await sendMessage(env, chatId, 'لطفاً یک عدد معتبر بین ۵ تا ۱۵۰ وارد کن.');
				return;
			}
			state.dailyKm = km;
			state.step = 'days_per_week';
			await setState(env, chatId, state);
			await sendMessage(
				env,
				chatId,
				'چند روز در هفته رانندگی می‌کنی؟ (عدد بین ۱ تا ۷)',
				makeKeyboard([['۱', '۲', '۳'], ['۴', '۵', '۶'], ['۷']])
			);
			return;
		}

		case 'days_per_week': {
			// اعداد فارسی رو هم به انگلیسی تبدیل می‌کنیم
			const normalized = text.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
			const days = Number(normalized);
			if (!Number.isInteger(days) || days < 1 || days > 7) {
				await sendMessage(env, chatId, 'لطفاً یک عدد معتبر بین ۱ تا ۷ وارد کن.');
				return;
			}
			state.daysPerWeek = days;
			state.step = 'driving_style';
			await setState(env, chatId, state);
			await sendMessage(env, chatId, 'سبک رانندگی‌ات چطوره؟', makeKeyboard([['آرام', 'معمولی', 'تند']]));
			return;
		}

		case 'driving_style': {
			if (!(text in DRIVING_STYLE_FACTOR)) {
				await sendMessage(env, chatId, 'لطفاً یکی از گزینه‌های آرام / معمولی / تند رو انتخاب کن.');
				return;
			}
			state.drivingStyle = text;
			const result = calculateSavings(state);
			await sendMessage(env, chatId, result, 'remove');
			await clearState(env, chatId);
			return;
		}
	}
}

// ---------------------------------------------------------------------------
// ورودی اصلی Worker
// ---------------------------------------------------------------------------

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method !== 'POST') {
			return new Response('این آدرس فقط برای دریافت webhook بله استفاده می‌شه.', { status: 200 });
		}

		// راستی‌آزمایی اختیاری وبهوک (اگه WEBHOOK_SECRET رو ست کرده باشی)
		if (env.WEBHOOK_SECRET) {
			const secretHeader = request.headers.get('X-Bale-Bot-Api-Secret-Token');
			if (secretHeader !== env.WEBHOOK_SECRET) {
				return new Response('Unauthorized', { status: 401 });
			}
		}

		let update: BaleUpdate;
		try {
			update = await request.json();
		} catch {
			return new Response('Bad Request', { status: 400 });
		}

		if (update.message) {
			try {
				await handleMessage(env, update.message);
			} catch (err) {
				console.error('خطا در پردازش پیام:', err);
			}
		}

		// همیشه ۲۰۰ برمی‌گردونیم تا بله دوباره همون آپدیت رو نفرسته
		return new Response('OK', { status: 200 });
	},
};
