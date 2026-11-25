require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const OpenAI = require("openai");
const { GoogleGenAI } = require("@google/genai");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

const gemini = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

const groq = process.env.GROQ_API_KEY
  ? new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
    })
  : null;

const SPOT_COORDS = {
  "Downtown City Plaza": { x: 140, y: 120 },
  "Sunset Cliffs Overlooking the Lake": { x: 560, y: 85 },
  "Lakeside Marina & Promenade": { x: 540, y: 215 },
  "Lakeside Terrace Restaurant": { x: 350, y: 205 },
  "Skyline Rooftop Lounge": { x: 240, y: 75 },
};

const onlinePlayers = new Map();
const friendGroups = new Map();

function coordsForSpot(spot) {
  return SPOT_COORDS[spot] || { x: 320, y: 145 };
}

function isMatch(a, b) {
  if (!a || !b || a.id === b.id) return false;
  const aWantsB = a.lookingFor === "Everyone" || a.lookingFor === b.gender;
  const bWantsA = b.lookingFor === "Everyone" || b.lookingFor === a.gender;
  const explicitlyMatched =
    (Array.isArray(a.matchedIds) && a.matchedIds.includes(b.id)) ||
    (Array.isArray(b.matchedIds) && b.matchedIds.includes(a.id)) ||
    a.driverId === b.id ||
    b.driverId === a.id;
  return explicitlyMatched || (aWantsB && bWantsA);
}

async function generateRealisticPortrait(prompt) {
  if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN) {
    try {
      const cfResp = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ prompt, steps: 4 }),
        }
      );
      if (cfResp.ok) {
        const cfJson = await cfResp.json();
        if (cfJson?.result?.image) {
          return `data:image/jpeg;base64,${cfJson.result.image}`;
        }
      }
    } catch (_e) {}
  }

  if (gemini) {
    for (const model of ["gemini-nano-banana-2.1", "gemini-3.1-flash-image"]) {
      try {
        const response = await gemini.models.generateContent({
          model,
          contents: prompt,
          config: { responseModalities: ["TEXT", "IMAGE"] },
        });
        const parts = response.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (part.inlineData?.data) {
            return `data:${part.inlineData.mimeType || "image/png"};base64,${part.inlineData.data}`;
          }
        }
      } catch (_e) {}
    }
  }

  const seed = Math.floor(Math.random() * 999999);
  const polUrl = process.env.POLLINATIONS_API_KEY
    ? `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?model=flux&width=512&height=512&seed=${seed}`
    : `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=512&seed=${seed}`;
  const headers = { "User-Agent": "Mozilla/5.0 HeartLoungeCity/5.0" };
  if (process.env.POLLINATIONS_API_KEY) {
    headers.Authorization = `Bearer ${process.env.POLLINATIONS_API_KEY}`;
  }
  const polResp = await fetch(polUrl, { headers });
  if (polResp.ok) {
    const buf = Buffer.from(await polResp.arrayBuffer());
    const mime = polResp.headers.get("content-type") || "image/jpeg";
    if (mime.startsWith("image/")) {
      return `data:${mime};base64,${buf.toString("base64")}`;
    }
  }

  throw new Error("Could not generate character portrait right now. Please try again.");
}

function moveDriverAndPassengers(driverId, newSpot) {
  const driver = onlinePlayers.get(driverId);
  if (!driver) return;
  const base = coordsForSpot(newSpot);
  driver.spot = newSpot;
  driver.pinnedSpot = newSpot;
  driver.x = base.x;
  driver.y = base.y;

  let seatOffset = 1;
  for (const p of onlinePlayers.values()) {
    if (p.driverId === driverId) {
      p.spot = newSpot;
      p.pinnedSpot = newSpot;
      p.currentCar = driver.currentCar;
      p.x = Math.min(660, base.x + seatOffset * 18);
      p.y = Math.min(245, base.y + seatOffset * 10);
      seatOffset += 1;
    }
  }
}

app.post("/api/verify-and-create", async (req, res) => {
  try {
    const {
      name = "Player",
      gender = "Male",
      lookingFor = "Everyone",
      vibe = "Sunset Cliffs Overlooking the Lake",
      hobby = "Sunset Drives & Good Food",
      lookStyle = "Anime & Lifelike Blend Portrait",
      selfieBase64 = "",
    } = req.body;

    if (!selfieBase64) {
      return res.status(400).json({ error: "Please upload or snap a real selfie first." });
    }

    let appearanceTraits = `real ${gender.toLowerCase()} with warm smile, natural features, stylish casual outfit`;
    let verified = true;

    if (gemini) {
      const cleanB64 = String(selfieBase64).replace(/^data:image\/\w+;base64,/, "");
      const checkPrompt = `
You are the safety & likeness verifier for a friendly social meetup game.
Inspect this photo and return ONLY valid JSON:
{
  "isRealPerson": true or false,
  "isWholesomeAndClear": true or false,
  "reason": "short reason if rejected, or 'Verified' if approved",
  "likenessDescription": "clear description of hair color, hairstyle, skin tone, facial features, glasses/accessories, expression, and outfit so an artist can render a faithful character"
}
Reject cartoons, blank screens, objects, or unclear faces.
      `.trim();

      const resp = await gemini.models.generateContent({
        model: "gemini-3.8-flash",
        contents: [
          {
            role: "user",
            parts: [
              { text: checkPrompt },
              { inlineData: { mimeType: "image/png", data: cleanB64 } },
            ],
          },
        ],
      });

      const raw = (resp.text || "").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(raw);
      verified = Boolean(parsed.isRealPerson && parsed.isWholesomeAndClear);
      if (!verified) {
        return res.status(400).json({
          verified: false,
          error: parsed.reason || "Photo could not be verified. Please upload a clear real selfie.",
        });
      }
      if (parsed.likenessDescription) {
        appearanceTraits = parsed.likenessDescription;
      }
    }

    const portraitPrompt = `${lookStyle} of a real ${gender.toLowerCase()}, ${appearanceTraits}, scenic lake and sunset cliffs in soft background, expressive eyes, warm friendly smile, clean detail`;
    const avatarUrl = await generateRealisticPortrait(portraitPrompt);
    const startSpot = vibe || "Sunset Cliffs Overlooking the Lake";
    const coords = coordsForSpot(startSpot);

    res.json({
      verified: true,
      profile: {
        name: String(name).slice(0, 28),
        gender,
        lookingFor,
        vibe: startSpot,
        hobby,
        avatarUrl,
        spot: startSpot,
        pinnedSpot: startSpot,
        x: coords.x,
        y: coords.y,
        currentCar: "Midnight Roadster Convertible (Sports)",
        currentMeal: "Iced Caramel Latte",
        mood: "✨ Ready to Cruise",
        hearts: "∞",
      },
    });
  } catch (err) {
    console.error("Verify/Create Error:", err);
    res.status(500).json({ error: err.message || "Verification failed" });
  }
});

app.post("/api/icebreaker", async (req, res) => {
  try {
    const { me, partner, spot, car, meal } = req.body;
    const prompt = `Write 2 short, friendly conversation starters for ${me?.name} (car: ${car || "city cruiser"}) chatting with ${partner?.name} at pinned spot "${spot || "Sunset Cliffs Overlooking the Lake"}" over "${meal || "a meal"}". Shared interests: ${me?.hobby} and ${partner?.hobby}.`;

    if (groq) {
      const out = await groq.chat.completions.create({
        model: "openai/gpt-oss-20b",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 150,
      });
      return res.json({ idea: out.choices?.[0]?.message?.content?.trim() });
    }
    res.json({ idea: `Ask ${partner?.name || "them"} what they love most about ${spot || "Sunset Cliffs Overlooking the Lake"}!` });
  } catch (_e) {
    res.json({ idea: "Say hi and ask which spot or meal they want to try next!" });
  }
});

function broadcastState() {
  io.emit("loungeUpdate", {
    players: Array.from(onlinePlayers.values()),
    groups: Array.from(friendGroups.values()),
  });
}

io.on("connection", (socket) => {
  socket.on("joinLounge", (profile) => {
    const spot = profile.pinnedSpot || profile.spot || "Sunset Cliffs Overlooking the Lake";
    const coords = coordsForSpot(spot);
    const player = {
      id: socket.id,
      ...profile,
      spot,
      pinnedSpot: spot,
      x: profile.x ?? coords.x,
      y: profile.y ?? coords.y,
      currentCar: profile.currentCar || "Midnight Roadster Convertible (Sports)",
      currentMeal: profile.currentMeal || "Iced Caramel Latte",
      mood: profile.mood || "✨ Ready to Cruise",
      driverId: null,
      matchedIds: [],
      groupId: null,
    };
    onlinePlayers.set(socket.id, player);
    broadcastState();
  });

  socket.on("moveCoords", ({ x, y }) => {
    const p = onlinePlayers.get(socket.id);
    if (!p) return;
    p.driverId = null;
    p.x = Math.max(40, Math.min(680, Number(x) || p.x));
    p.y = Math.max(40, Math.min(245, Number(y) || p.y));

    let seatOffset = 1;
    for (const other of onlinePlayers.values()) {
      if (other.driverId === socket.id) {
        other.x = Math.min(680, p.x + seatOffset * 18);
        other.y = Math.min(245, p.y + seatOffset * 10);
        other.spot = p.spot;
        other.pinnedSpot = p.pinnedSpot;
        seatOffset += 1;
      }
    }
    broadcastState();
  });

  socket.on("setMood", ({ mood }) => {
    const p = onlinePlayers.get(socket.id);
    if (!p || !mood) return;
    p.mood = String(mood).slice(0, 32);
    broadcastState();
  });

  socket.on("pinLocation", ({ spot }) => {
    const p = onlinePlayers.get(socket.id);
    if (!p || !spot) return;
    moveDriverAndPassengers(socket.id, spot);
    broadcastState();
  });

  socket.on("changeSpot", ({ spot }) => {
    const p = onlinePlayers.get(socket.id);
    if (!p || !spot) return;
    p.driverId = null;
    moveDriverAndPassengers(socket.id, spot);

    if (p.groupId && friendGroups.has(p.groupId)) {
      const grp = friendGroups.get(p.groupId);
      grp.spot = spot;
      grp.members.forEach((m) => {
        const memberObj = onlinePlayers.get(m.id);
        if (memberObj) {
          memberObj.spot = spot;
          memberObj.pinnedSpot = spot;
          memberObj.driverId = null;
        }
      });
      io.to(p.groupId).emit("groupEvent", {
        text: `🚗 ${p.name} drove the group in their ${p.currentCar} to ${spot}!`,
      });
    }
    broadcastState();
  });

  socket.on("selectFreeCar", ({ car }) => {
    const p = onlinePlayers.get(socket.id);
    if (!p || !car) return;
    p.driverId = null;
    p.currentCar = car;
    for (const other of onlinePlayers.values()) {
      if (other.driverId === socket.id) other.currentCar = car;
    }
    if (p.groupId && friendGroups.has(p.groupId)) {
      const grp = friendGroups.get(p.groupId);
      grp.car = car;
      io.to(p.groupId).emit("groupEvent", {
        text: `🚘 ${p.name} pulled up with a "${car}" for the group (FREE ∞)!`,
      });
    }
    broadcastState();
  });

  socket.on("pickUpPerson", ({ targetId }) => {
    const driver = onlinePlayers.get(socket.id);
    const passenger = onlinePlayers.get(targetId);
    if (!driver || !passenger || socket.id === targetId) return;

    driver.driverId = null;
    passenger.driverId = socket.id;
    passenger.spot = driver.spot;
    passenger.pinnedSpot = driver.pinnedSpot;
    passenger.currentCar = driver.currentCar;
    passenger.x = Math.min(680, (driver.x || 320) + 18);
    passenger.y = Math.min(245, (driver.y || 145) + 10);

    if (!driver.matchedIds.includes(targetId)) driver.matchedIds.push(targetId);
    if (!passenger.matchedIds.includes(socket.id)) passenger.matchedIds.push(socket.id);

    io.to(targetId).emit("pickedUpInCar", {
      driverId: socket.id,
      driverName: driver.name,
      car: driver.currentCar,
      spot: driver.spot,
    });
    socket.emit("pickupConfirmed", {
      passengerId: targetId,
      passengerName: passenger.name,
      car: driver.currentCar,
      spot: driver.spot,
    });
    broadcastState();
  });

  socket.on("dropOffRide", () => {
    const p = onlinePlayers.get(socket.id);
    if (!p) return;
    p.driverId = null;
    for (const other of onlinePlayers.values()) {
      if (other.driverId === socket.id) other.driverId = null;
    }
    broadcastState();
  });

  socket.on("orderFreeMeal", ({ meal }) => {
    const p = onlinePlayers.get(socket.id);
    if (!p || !meal) return;
    p.currentMeal = meal;
    if (p.groupId && friendGroups.has(p.groupId)) {
      const grp = friendGroups.get(p.groupId);
      grp.meal = meal;
      io.to(p.groupId).emit("groupEvent", {
        text: `🍽️ ${p.name} ordered "${meal}" for the whole group (FREE ∞)!`,
      });
    }
    broadcastState();
  });

  socket.on("meetUpWith", ({ targetId }) => {
    const me = onlinePlayers.get(socket.id);
    const other = onlinePlayers.get(targetId);
    if (!me || !other) return;

    const targetSpot = other.pinnedSpot || other.spot;
    const coords = coordsForSpot(targetSpot);
    me.spot = targetSpot;
    me.pinnedSpot = targetSpot;
    me.x = Math.max(40, coords.x - 16);
    me.y = coords.y;

    if (!me.matchedIds.includes(targetId)) me.matchedIds.push(targetId);
    if (!other.matchedIds.includes(socket.id)) other.matchedIds.push(socket.id);

    io.to(targetId).emit("meetupUnlocked", {
      partnerId: socket.id,
      partnerName: me.name,
      spot: me.spot,
    });
    socket.emit("meetupUnlocked", {
      partnerId: targetId,
      partnerName: other.name,
      spot: me.spot,
    });
    broadcastState();
  });

  socket.on("matchOnlyChat", ({ toId, text }) => {
    const sender = onlinePlayers.get(socket.id);
    const recipient = onlinePlayers.get(toId);
    const cleanText = String(text || "").trim().slice(0, 400);
    if (!sender || !recipient || !cleanText) return;

    if (!isMatch(sender, recipient)) {
      socket.emit("systemNotice", `You can only chat privately with matching players (like ${recipient.name}).`);
      return;
    }

    const msgPayload = {
      fromId: socket.id,
      toId,
      fromName: sender.name,
      toName: recipient.name,
      pinnedSpot: sender.pinnedSpot,
      text: cleanText,
    };

    io.to(toId).emit("matchBubbleMessage", msgPayload);
    socket.emit("matchBubbleMessage", msgPayload);
  });

  socket.on("createFriendGroup", ({ groupName, spot, meal }) => {
    const me = onlinePlayers.get(socket.id);
    if (!me) return;
    const groupId = `grp_${Date.now()}_${Math.floor(Math.random() * 999)}`;
    const chosenSpot = spot || me.pinnedSpot || "Sunset Cliffs Overlooking the Lake";
    const chosenMeal = meal || "Nyama Choma & Lake Tilapia Platter";

    me.driverId = null;
    moveDriverAndPassengers(socket.id, chosenSpot);
    me.currentMeal = chosenMeal;
    me.groupId = groupId;
    socket.join(groupId);

    friendGroups.set(groupId, {
      id: groupId,
      name: String(groupName || `${me.name}'s City & Lake Crew`).slice(0, 32),
      spot: chosenSpot,
      meal: chosenMeal,
      car: me.currentCar,
      members: [{ id: socket.id, name: me.name, avatarUrl: me.avatarUrl }],
    });
    broadcastState();
  });

  socket.on("joinFriendGroup", ({ groupId }) => {
    const me = onlinePlayers.get(socket.id);
    const grp = friendGroups.get(groupId);
    if (!me || !grp) return;

    me.driverId = null;
    moveDriverAndPassengers(socket.id, grp.spot);
    me.currentMeal = grp.meal;
    me.groupId = groupId;
    socket.join(groupId);

    if (!grp.members.some((m) => m.id === socket.id)) {
      grp.members.push({ id: socket.id, name: me.name, avatarUrl: me.avatarUrl });
    }
    io.to(groupId).emit("groupEvent", {
      text: `✨ ${me.name} arrived in a ${me.currentCar} and joined the group at ${grp.spot} for ${grp.meal}!`,
    });
    broadcastState();
  });

  socket.on("groupChat", ({ groupId, text }) => {
    const me = onlinePlayers.get(socket.id);
    if (!me || !groupId || !text) return;
    io.to(groupId).emit("groupMessage", {
      fromName: me.name,
      text: String(text).slice(0, 400),
    });
  });

  socket.on("disconnect", () => {
    for (const p of onlinePlayers.values()) {
      if (p.driverId === socket.id) p.driverId = null;
    }
    const me = onlinePlayers.get(socket.id);
    if (me?.groupId && friendGroups.has(me.groupId)) {
      const grp = friendGroups.get(me.groupId);
      grp.members = grp.members.filter((m) => m.id !== socket.id);
      if (grp.members.length === 0) friendGroups.delete(me.groupId);
    }
    onlinePlayers.delete(socket.id);
    broadcastState();
  });
});

server.listen(PORT, () => {
  console.log(`Heart Lounge City running at http://localhost:${PORT}`);
});
