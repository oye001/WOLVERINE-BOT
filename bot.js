"use strict";

var Telegraf = require("telegraf").Telegraf;
var Groq = require("groq-sdk");
var http = require("http");
var fs = require("fs");
var path = require("path");

// - Emoji map (pure unicode escapes) -
var E = {
  rocket : "\u{1F680}",
  fire   : "\u{1F525}",
  chart  : "\u{1F4C8}",
  lock   : "\u{1F512}",
  check  : "\u2705",
  zap    : "\u26A1",
  gem    : "\u{1F48E}",
  star   : "\u2B50",
  money  : "\u{1F4B0}",
  shield : "\u{1F6E1}",
  copy   : "\u{1F4CB}",
  bird   : "\u{1F426}",
  wave   : "\u{1F44B}",
  dash   : "\u2014",
  wolf   : "\u{1F43A}",
  claw   : "\u{1F9B7}",
};

// - Token config -
var CA      = "0xd30D5c2078e7dD07B61d24C3186B74190bF6dAD4";
var CHART   = "https://dexscreener.com/bsc/" + CA;
var BUY     = "https://pancakeswap.finance/swap?outputCurrency=" + CA;
var TWITTER = "https://x.com/WOLVERINEbsc";
var TG_LINK = "https://t.me/WOLVERINEonbsc_official";

// - Environment -
var bot  = new Telegraf(process.env.BOT_TOKEN);
var groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// - State -
var caUnlocked     = false;
var groupChatId    = null;
var silenceTimer   = null;
var imageMessages  = new Map();
var strikes        = new Map();
var spamTracker    = new Map();
var stickerTracker = new Map();
var lastReplies    = [];
var MAX_REPLY_HIST = 12;

var IMG          = path.join(__dirname, "siren.jpg");
var SILENCE_DELAY = 10 * 60 * 1000;
var STRIKE_RESET  = 86400000;
var SPAM_WINDOW   = 60000;
var SPAM_MAX      = 5;

// - Groq system prompt -
function systemPrompt(withCa) {
  return (
    "You are the official Telegram bot for $WOLVE, a BNB Smart Chain meme token.\n\n" +
    "TOKEN FACTS:\n" +
    "- Name: Wolverine | Ticker: $WOLVE\n" +
    "- Blockchain: BNB Smart Chain (BSC)\n" +
    "- Total Supply: 1,000,000,000\n" +
    "- Max Wallet: 4.9% \u2014 anti-whale protection cap. No single wallet can hold more than 49,000,000 $WOLVE. This is a security feature, not a distribution.\n" +
    "- Buy Tax: 5% | Sell Tax: 5%\n" +
    "- Contract: RENOUNCED \u2014 the contract code is permanently locked. Nobody can alter it. This is a security feature, not an exit.\n" +
    "- Liquidity: LOCKED \u2014 funds are fully secured.\n" +
    "- DEV STATUS: The dev is ACTIVE \u2014 present in the group, watching every candle, working on marketing and growth every day. Renouncing the contract is a SECURITY FEATURE, not an exit. Never say or imply the dev stepped back, stepped aside, handed over control, or is gone.\n" +
    "- Twitter/X: " + TWITTER + "\n" +
    (withCa ? "- Contract Address: " + CA + "\n" : "") +
    (withCa ? "- Chart: " + CHART + "\n" : "") +
    (withCa ? "- Buy: " + BUY + "\n" : "") +
    "\nNARRATIVE:\n" +
    "In a market filled with noise, hype, and weak hands, a new force is emerging. Not loud. Not desperate. Just relentless.\n" +
    "$WOLVERINE is built on strength, resilience, and community. A token for believers who understand that real momentum is built over time.\n" +
    "Like a lone predator, $WOLVERINE moves quietly \u2014 watching, growing, preparing. Then when the moment comes, it strikes.\n" +
    "No fear. No limits. No retreat. This is more than a meme token. This is a movement.\n" +
    "The early believers know\u2026 the strongest always survive. Claws out. The hunt begins.\n\n" +
    "PERSONALITY:\n" +
    "- Calm, confident, warm, genuinely bullish \u2014 never fake hype\n" +
    "- Every reply must feel completely different every time\n" +
    "- Vary words, structure, energy, opening, and tone with every response\n" +
    "- Never robotic, never corporate, never stiff\n" +
    "- Minimal emojis \u2014 natural, never forced\n" +
    "- Short questions = 1-3 lines | Detailed questions = up to 5 lines\n" +
    "- Express dev activity differently every single time \u2014 never same phrasing\n\n" +
    "HARD RULES:\n" +
    "- NEVER share the Telegram group link \u2014 users are already in the group\n" +
    "- NEVER volunteer the CA unless directly asked\n" +
    "- NEVER place an emoji directly before or after the contract address on the same line\n" +
    "- NEVER repeat the same reply twice\n" +
    "- NEVER use corporate or stiff language\n" +
    "- If a message is hype, casual chat, or does not need an answer, reply with exactly: IGNORE\n"
  );
}

// - Groq call -
async function askGroq(sysprompt, userMsg) {
  var res = await groq.chat.completions.create({
    model       : "llama-3.3-70b-versatile",
    temperature : 1.0,
    max_tokens  : 300,
    messages    : [
      { role: "system", content: sysprompt },
      { role: "user",   content: userMsg   },
    ],
  });
  return res.choices[0].message.content.trim();
}

// - Dedup helpers -
function isDupe(r) { return lastReplies.includes(r); }
function recordReply(r) {
  lastReplies.push(r);
  if (lastReplies.length > MAX_REPLY_HIST) lastReplies.shift();
}

async function askGroqUnique(sysprompt, userMsg) {
  var reply = await askGroq(sysprompt, userMsg);
  if (isDupe(reply)) {
    reply = await askGroq(sysprompt, userMsg + " Give a completely different response from before.");
  }
  recordReply(reply);
  return reply;
}

// - Image helpers -
async function deletePrevImage(chatId) {
  var mid = imageMessages.get(chatId);
  if (mid) {
    try { await bot.telegram.deleteMessage(chatId, mid); } catch (_) {}
    imageMessages.delete(chatId);
  }
}

async function sendImage(chatId, caption, extra) {
  await deletePrevImage(chatId);
  extra = extra || {};
  try {
    if (fs.existsSync(IMG)) {
      var m = await bot.telegram.sendPhoto(chatId, { source: IMG }, Object.assign({ caption: caption, parse_mode: "HTML" }, extra));
      imageMessages.set(chatId, m.message_id);
      return m;
    }
  } catch (_) {}
  return bot.telegram.sendMessage(chatId, caption, Object.assign({ parse_mode: "HTML" }, extra));
}

// - Auto-delete helper -
function autoDelete(chatId, msgId, delay) {
  setTimeout(function() {
    try { bot.telegram.deleteMessage(chatId, msgId); } catch (_) {}
  }, delay);
}

// - Admin check -
async function isAdmin(ctx, userId) {
  var chatType = ctx.chat && ctx.chat.type;
  if (chatType !== "group" && chatType !== "supergroup") return false;
  try {
    var member = await ctx.telegram.getChatMember(ctx.chat.id, userId);
    return member.status === "administrator" || member.status === "creator";
  } catch (_) {
    return false;
  }
}

// - Strike system -
function getStrikes(userId) {
  var now = Date.now();
  var rec = strikes.get(userId);
  if (!rec || (now - rec.since) > STRIKE_RESET) {
    rec = { count: 0, since: now };
    strikes.set(userId, rec);
  }
  return rec;
}

async function applyStrike(ctx, userId) {
  var rec = getStrikes(userId);
  rec.count += 1;
  strikes.set(userId, rec);

  try { await ctx.deleteMessage(); } catch (_) {}

  if (rec.count === 1) {
    var m1 = await ctx.reply("\u26A0\uFE0F Warning 1/3 \u2014 keep it clean in here.");
    autoDelete(ctx.chat.id, m1.message_id, 10000);
  } else if (rec.count === 2) {
    var m2 = await ctx.reply("\u26A0\uFE0F Warning 2/3 \u2014 one more and you\u2019re muted.");
    autoDelete(ctx.chat.id, m2.message_id, 10000);
  } else if (rec.count >= 3) {
    rec.count = 0;
    strikes.set(userId, rec);
    try {
      await ctx.telegram.restrictChatMember(ctx.chat.id, userId, {
        permissions: { can_send_messages: false },
        until_date: Math.floor(Date.now() / 1000) + 300,
      });
    } catch (_) {}
    var m3 = await ctx.reply("\u{1F6D1} Muted for 5 minutes. Cool down.");
    autoDelete(ctx.chat.id, m3.message_id, 12000);
  }
}

// - Anti-spam -
async function checkSpam(ctx, userId) {
  var now = Date.now();
  var rec = spamTracker.get(userId) || { count: 0, since: now };
  if ((now - rec.since) > SPAM_WINDOW) { rec = { count: 0, since: now }; }
  rec.count += 1;
  spamTracker.set(userId, rec);
  if (rec.count > SPAM_MAX) {
    try {
      await ctx.telegram.restrictChatMember(ctx.chat.id, userId, {
        permissions: { can_send_messages: false },
        until_date: Math.floor(Date.now() / 1000) + 300,
      });
    } catch (_) {}
    var m = await ctx.reply("\u{1F6D1} Slow down! Muted 5 minutes for spamming.");
    autoDelete(ctx.chat.id, m.message_id, 15000);
    return true;
  }
  return false;
}

// - Not-live reply pool -
var notLiveMsgs = [
  "$WOLVE hasn\u2019t officially launched yet. Stay close \u2014 the CA drops soon.",
  "Not yet. The contract reveal is coming. Stay patient and stay ready.",
  "CA isn\u2019t live yet. When it drops, you\u2019ll be first to know. Stay in the group.",
  "Hold tight. $WOLVERINE launches soon. The CA will be revealed when the time is right.",
  "We\u2019re not there yet. Sit tight \u2014 the launch is close.",
];
var notLiveIdx = 0;
function getNotLiveMsg() {
  var msg = notLiveMsgs[notLiveIdx % notLiveMsgs.length];
  notLiveIdx++;
  return msg;
}

// - CA reply -
var caPrompts = [
  "Write 3-4 punchy bullish lines about why $WOLVE is the move right now. Do NOT include the contract address in your reply.",
  "Give 3-4 lines about the strength and resilience of $WOLVERINE as a community token. Do NOT include the contract address.",
  "Write 3-4 lines about why early holders of $WOLVE are in a great position. Do NOT include the contract address.",
  "Give 3-4 lines about $WOLVERINE\u2019s clean fundamentals and why it stands out. Do NOT include the contract address.",
  "Write 3-4 lines about what makes $WOLVE different from other meme tokens. Do NOT include the contract address.",
  "Give 3-4 short powerful lines about $WOLVERINE\u2019s momentum and future. Do NOT include the contract address.",
  "Write 3-4 lines about the community behind $WOLVE and why this token survives. Do NOT include the contract address.",
];
var caPromptIdx = 0;

async function buildCaCaption() {
  var prompt = caPrompts[caPromptIdx % caPrompts.length];
  caPromptIdx++;
  var aiText = await askGroqUnique(systemPrompt(true), prompt);
  return aiText + "\n\n" + CA + "\n\n" + E.lock + " Renounced " + E.check + " LP Locked";
}

async function sendCaReply(ctx) {
  if (!caUnlocked) {
    return ctx.reply(getNotLiveMsg());
  }
  var caption = await buildCaCaption();
  await sendImage(ctx.chat.id, caption, {
    reply_markup: {
      inline_keyboard: [[{ text: E.copy + " Copy CA", copy_text: { text: CA } }]],
    },
  });
}

// - X / Twitter reply -
var xPrompts = [
  "Write 1-2 short punchy lines inviting people to follow $WOLVERINE on X. Keep it sharp and exciting.",
  "Give 1-2 lines about why following $WOLVE on X keeps you ahead of the pack.",
  "Write 1-2 lines about what makes the $WOLVERINE X page worth following right now.",
  "Give 1-2 lines of hype about $WOLVE\u2019s X presence. Short, punchy, and real.",
  "Write 1-2 lines about the $WOLVERINE community on X and why you should be part of it.",
];
var xPromptIdx = 0;

async function buildXCaption() {
  var prompt = xPrompts[xPromptIdx % xPrompts.length];
  xPromptIdx++;
  var aiText = await askGroqUnique(systemPrompt(false), prompt);
  return aiText + "\n\n@WOLVERINEbsc";
}

async function sendXReply(ctx) {
  var caption = await buildXCaption();
  await sendImage(ctx.chat.id, caption, {
    reply_markup: {
      inline_keyboard: [[{ text: E.bird + " Follow on X", url: TWITTER }]],
    },
  });
}

// - Socials reply -
var socialsFormats = [
  function() {
    return (
      E.wolf + " <b>$WOLVERINE Official Links</b>\n\n" +
      E.bird + " <a href=\"" + TWITTER + "\">Follow on X</a>\n" +
      E.chart + " <a href=\"" + CHART + "\">View Chart</a>\n" +
      E.rocket + " <a href=\"" + BUY + "\">Buy on PancakeSwap</a>"
    );
  },
  function() {
    return (
      "<b>Claws Out " + E.wolf + " Find $WOLVE Here:</b>\n\n" +
      "X \u2192 <a href=\"" + TWITTER + "\">@WOLVERINEbsc</a>\n" +
      "Chart \u2192 <a href=\"" + CHART + "\">DexScreener</a>\n" +
      "Buy \u2192 <a href=\"" + BUY + "\">PancakeSwap</a>"
    );
  },
  function() {
    return (
      E.fire + " <b>Stay connected with $WOLVERINE:</b>\n\n" +
      "\u2022 Twitter: <a href=\"" + TWITTER + "\">x.com/WOLVERINEbsc</a>\n" +
      "\u2022 Chart: <a href=\"" + CHART + "\">DexScreener</a>\n" +
      "\u2022 Trade: <a href=\"" + BUY + "\">PancakeSwap</a>"
    );
  },
  function() {
    return (
      "<b>The Hunt is On " + E.wolf + "</b>\n\n" +
      E.bird + " <a href=\"" + TWITTER + "\">X \u2014 @WOLVERINEbsc</a>\n" +
      E.chart + " <a href=\"" + CHART + "\">DexScreener Chart</a>\n" +
      E.money + " <a href=\"" + BUY + "\">Buy $WOLVE Now</a>"
    );
  },
];
var socialsIdx = 0;

function getSocialsMsg() {
  var msg = socialsFormats[socialsIdx % socialsFormats.length]();
  socialsIdx++;
  return msg;
}

// - Silence breaker -
var silenceAngles = [
  "Write 4-5 bullish lines about why now is the best time to buy and hold $WOLVERINE.",
  "Write 4-5 lines about the early opportunity in $WOLVE for those paying attention right now.",
  "Compare $WOLVERINE to early DOGE and PEPE \u2014 write 4-5 bullish lines about the potential.",
  "Write 4-5 lines about $WOLVE\u2019s clean fundamentals: renounced, locked, low tax, max wallet protection.",
  "Write 4-5 lines about the psychology of early investors in $WOLVERINE and why they\u2019re winning.",
  "Write 4-5 lines about the strength of the $WOLVERINE community and what it means for the token\u2019s future.",
  "Write 4-5 lines about why $WOLVE\u2019s silent accumulation phase is the move smart holders make.",
  "Write 4-5 lines about resilience in crypto and how $WOLVERINE embodies that spirit perfectly.",
];
var silenceIdx = 0;

async function fireSilenceBreaker() {
  if (!groupChatId) { resetSilence(); return; }
  var prompt = silenceAngles[silenceIdx % silenceAngles.length];
  silenceIdx++;
  try {
    var caption = await askGroqUnique(systemPrompt(caUnlocked), prompt);
    await sendImage(groupChatId, caption, {});
  } catch (_) {}
  resetSilence();
}

function resetSilence() {
  if (silenceTimer) clearTimeout(silenceTimer);
  silenceTimer = setTimeout(fireSilenceBreaker, SILENCE_DELAY);
}

// - Welcome messages -
function buildWelcomePrompt(name) {
  return (
    "Write a warm, genuine, bullish welcome for " + name + " joining the $WOLVERINE Telegram group. " +
    "Max 4 lines. Never start with the word 'Welcome'. " +
    "Vary the opening, tone, and structure completely every time. " +
    "Make it feel personal and exciting. " +
    "Never mention the Telegram group link. " +
    (caUnlocked ? "You may naturally reference the chart or how to buy." : "Do not mention the CA or chart links yet.") +
    " Never use corporate or stiff language."
  );
}

// - FUD / bad language keywords -
var BAD_WORDS = [
  "rug", "rugpull", "scam", "ponzi", "honeypot",
  "shit", "fuck", "bitch", "bastard", "asshole", "cunt", "retard", "idiot",
  "dump", "dumping", "dead", "worthless", "trash", "garbage",
  "fake", "fraud", "exit scam", "dev ran", "dev is gone", "abandoned",
];

function hasBadWord(text) {
  var lower = text.toLowerCase();
  for (var i = 0; i < BAD_WORDS.length; i++) {
    if (lower.indexOf(BAD_WORDS[i]) !== -1) return true;
  }
  return false;
}

function hasExternalLink(text) {
  var urlRegex = /https?:\/\/[^\s]+|t\.me\/[^\s]+|@[A-Za-z0-9_]{3,}/g;
  var matches = text.match(urlRegex);
  if (!matches) return false;
  for (var i = 0; i < matches.length; i++) {
    var m = matches[i].toLowerCase();
    if (m.indexOf("x.com") !== -1 || m.indexOf("twitter.com") !== -1) continue;
    return true;
  }
  return false;
}

function hasExternalMention(text) {
  var mentionRegex = /@[A-Za-z0-9_]{3,}/g;
  return mentionRegex.test(text);
}

// - CA / X / socials trigger detection -
function isCaRequest(text) {
  var t = text.toLowerCase();
  return t.indexOf("ca") !== -1 || t.indexOf("contract") !== -1 || t.indexOf("address") !== -1;
}

function isXRequest(text) {
  var t = text.toLowerCase();
  return t === "x" || t === "/x" || t === "twitter" || t === "/twitter" ||
    t.indexOf("twitter") !== -1 || t.indexOf(" x ") !== -1 || t.indexOf("follow") !== -1;
}

function isSocialsRequest(text) {
  var t = text.toLowerCase();
  return t.indexOf("socials") !== -1 || t.indexOf("links") !== -1 || t === "/socials" || t === "/links";
}

function isBuyRequest(text) {
  var t = text.toLowerCase();
  return t.indexOf("how to buy") !== -1 || t.indexOf("where to buy") !== -1 || t.indexOf("buy ") !== -1 || t === "buy";
}

// - Commands -
bot.command("start", function(ctx) {
  return ctx.reply(
    E.wolf + " <b>$WOLVERINE Bot is live.</b>\n\nAsk me anything about the token \u2014 I\u2019ve got you.\n\nClaws out. The hunt begins.",
    { parse_mode: "HTML" }
  );
});

bot.command("ca", function(ctx) { return sendCaReply(ctx); });
bot.command("contract", function(ctx) { return sendCaReply(ctx); });

bot.command("x", function(ctx) { return sendXReply(ctx); });
bot.command("twitter", function(ctx) { return sendXReply(ctx); });

bot.command("socials", function(ctx) {
  return ctx.reply(getSocialsMsg(), { parse_mode: "HTML", disable_web_page_preview: true });
});
bot.command("links", function(ctx) {
  return ctx.reply(getSocialsMsg(), { parse_mode: "HTML", disable_web_page_preview: true });
});

bot.command("buy", function(ctx) {
  return ctx.reply(
    E.rocket + " <b>Buy $WOLVE on PancakeSwap:</b>\n<a href=\"" + BUY + "\">Click here to buy</a>",
    { parse_mode: "HTML" }
  );
});

bot.command("chart", function(ctx) {
  return ctx.reply(
    E.chart + " <b>$WOLVERINE Chart:</b>\n<a href=\"" + CHART + "\">View on DexScreener</a>",
    { parse_mode: "HTML" }
  );
});

bot.command("revealca", async function(ctx) {
  var chatType = ctx.chat && ctx.chat.type;
  if (chatType === "private") {
    caUnlocked = true;
    await ctx.reply("CA is now REVEALED.");
    return;
  }
  var admin = await isAdmin(ctx, ctx.from.id);
  if (!admin) return;
  caUnlocked = true;
  var m = await ctx.reply("CA is now live and visible.");
  autoDelete(ctx.chat.id, m.message_id, 10000);
});

bot.command("hideca", async function(ctx) {
  var chatType = ctx.chat && ctx.chat.type;
  if (chatType === "private") {
    caUnlocked = false;
    await ctx.reply("CA is now HIDDEN.");
    return;
  }
  var admin = await isAdmin(ctx, ctx.from.id);
  if (!admin) return;
  caUnlocked = false;
  var m = await ctx.reply("CA is now hidden.");
  autoDelete(ctx.chat.id, m.message_id, 10000);
});

// - Welcome handler -
bot.on("new_chat_members", async function(ctx) {
  var members = ctx.message.new_chat_members;
  try { await ctx.deleteMessage(); } catch (_) {}
  for (var i = 0; i < members.length; i++) {
    var member = members[i];
    if (member.is_bot) continue;
    var name = member.first_name || "Warrior";
    try {
      var welcomeText = await askGroqUnique(systemPrompt(caUnlocked), buildWelcomePrompt(name));
      var wm = await ctx.reply(welcomeText);
      autoDelete(ctx.chat.id, wm.message_id, 60000);
    } catch (_) {}
  }
});

// - Sticker handler -
bot.on("sticker", async function(ctx) {
  var userId = ctx.from && ctx.from.id;
  if (!userId) return;

  if (await isAdmin(ctx, userId)) return;

  // Forwarded sticker = strike
  if (ctx.message.forward_date || ctx.message.forward_from || ctx.message.forward_from_chat) {
    return applyStrike(ctx, userId);
  }

  // Consecutive sticker count
  var count = (stickerTracker.get(userId) || 0) + 1;
  stickerTracker.set(userId, count);
  if (count > 3) {
    try { await ctx.deleteMessage(); } catch (_) {}
  }

  if (groupChatId === null && ctx.chat && (ctx.chat.type === "group" || ctx.chat.type === "supergroup")) {
    groupChatId = ctx.chat.id;
  }
  resetSilence();
});

// - Forwarded media handler -
bot.on(["photo", "video", "document", "audio", "voice"], async function(ctx) {
  var userId = ctx.from && ctx.from.id;
  if (!userId) return;
  if (await isAdmin(ctx, userId)) return;
  if (ctx.message.forward_date || ctx.message.forward_from || ctx.message.forward_from_chat) {
    return applyStrike(ctx, userId);
  }

  if (groupChatId === null && ctx.chat && (ctx.chat.type === "group" || ctx.chat.type === "supergroup")) {
    groupChatId = ctx.chat.id;
  }
  resetSilence();
});

// - Main message handler -
bot.on("message", async function(ctx) {
  if (!ctx.message || !ctx.message.text) return;

  var text     = ctx.message.text;
  var userId   = ctx.from && ctx.from.id;
  var chatType = ctx.chat && ctx.chat.type;
  var isGroup  = chatType === "group" || chatType === "supergroup";
  var isDM     = chatType === "private";

  // Capture group chat ID
  if (isGroup && groupChatId === null) {
    groupChatId = ctx.chat.id;
  }

  // Reset silence on any group message
  if (isGroup) resetSilence();

  // Reset sticker counter on text
  if (userId) stickerTracker.set(userId, 0);

  // Moderation (group only, non-admins)
  if (isGroup && userId) {
    var admin = await isAdmin(ctx, userId);
    if (!admin) {
      // Spam check
      var spammed = await checkSpam(ctx, userId);
      if (spammed) return;

      // Forwarded message
      if (ctx.message.forward_date || ctx.message.forward_from || ctx.message.forward_from_chat) {
        return applyStrike(ctx, userId);
      }

      // External links (allow x.com / twitter.com)
      if (hasExternalLink(text)) {
        return applyStrike(ctx, userId);
      }

      // External @mentions
      if (hasExternalMention(text)) {
        return applyStrike(ctx, userId);
      }

      // Bad words / FUD
      if (hasBadWord(text)) {
        return applyStrike(ctx, userId);
      }
    }
  }

  // - Trigger routing -

  // CA request
  if (isCaRequest(text)) {
    return sendCaReply(ctx);
  }

  // X / Twitter
  if (isXRequest(text)) {
    return sendXReply(ctx);
  }

  // Socials / Links
  if (isSocialsRequest(text)) {
    return ctx.reply(getSocialsMsg(), { parse_mode: "HTML", disable_web_page_preview: true });
  }

  // Buy request
  if (isBuyRequest(text)) {
    return ctx.reply(
      E.rocket + " <b>Buy $WOLVE on PancakeSwap:</b>\n<a href=\"" + BUY + "\">Click here to buy</a>",
      { parse_mode: "HTML" }
    );
  }

  // Chart request
  if (text.toLowerCase().indexOf("chart") !== -1 || text.toLowerCase().indexOf("price") !== -1) {
    return ctx.reply(
      E.chart + " <b>$WOLVERINE Chart:</b>\n<a href=\"" + CHART + "\">View on DexScreener</a>",
      { parse_mode: "HTML" }
    );
  }

  // In DMs: always answer via AI
  if (isDM) {
    try {
      var dmReply = await askGroqUnique(systemPrompt(caUnlocked), text);
      if (dmReply !== "IGNORE") {
        return ctx.reply(dmReply);
      }
    } catch (_) {}
    return;
  }

  // In group: AI decides whether to reply or ignore
  if (isGroup) {
    try {
      var aiReply = await askGroqUnique(systemPrompt(caUnlocked), text);
      if (aiReply === "IGNORE") return;
      return ctx.reply(aiReply);
    } catch (_) {}
  }
});

// - Keep-alive HTTP server -
http.createServer(function(req, res) {
  res.writeHead(200);
  res.end("OK");
}).listen(process.env.PORT || 3000);

// - Launch -
bot.launch().then(function() {
  console.log("$WOLVERINE bot is running");
  resetSilence();
}).catch(console.error);

process.once("SIGINT",  function() { bot.stop("SIGINT");  });
process.once("SIGTERM", function() { bot.stop("SIGTERM"); });
