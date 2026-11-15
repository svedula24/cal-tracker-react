# Apple Health steps with a Shortcut

Kalo on the iPhone home screen is a web app, and a web app cannot read Apple Health. A Shortcuts
automation on the iPhone can: it reads today's step count from Health and sends it to Kalo. Kalo
stores it as that day's steps (it keeps the day type and workout calories) and the app shows it on
its next sync. Only steps are sent.

The app's **Goals → Apple Health steps** screen makes the token, shows the URL and repeats the steps
below in short form.

## What Kalo provides

| Request | Token | What it does |
| --- | --- | --- |
| `POST /api/v1/integration-tokens` `{"label": "Apple Health"}` | device | 201 `{"id", "token", "label", "created_at"}`. The token is shown this once; the server keeps only its hash. At most 10 live per user (409). |
| `GET /api/v1/integration-tokens` | device | `{"tokens": [{"id", "label", "created_at", "last_used_at"}]}`, without the tokens. |
| `DELETE /api/v1/integration-tokens/{id}` | device | 204. The token stops working on its next request. |
| `PUT /api/v1/daily-activity/{date}/steps` `{"steps": 8123}` | integration (or device) | 200 `{"activity_date", "steps", "day_type", "workout_kcal"}`. |

About the steps request:

- `{date}` is `YYYY-MM-DD` in your own calendar (the timezone Kalo has for you). A day after today
  is refused with 422.
- It sets the day's steps and nothing else. It goes through the same code as the app's sync, so the
  phone pulls it on its next sync.
- Each run sends the day's total so far, so a count lower than the stored one replaces it too.
  Sending the same count again changes nothing.
- **0 never replaces a count above 0.** A run while the iPhone is locked cannot read Health and sums
  nothing; that must not wipe the day, so Kalo keeps the stored count (the shortcut below also skips
  sending 0).
- `steps` may be a whole number, a number with decimals (rounded) or a number as text, with or without
  thousands separators (`8,123`, `8 123`): the shortcut works even if a Round action is missing or the
  field is Text. In text a dot is a decimal point (`8.123` is 8 steps), so prefer a Number field.
- **An integration token can only do this.** Every route that needs a token answers 401 to it: it cannot read
  your diary, create tokens or revoke anything. If the shortcut (and its token) is shared by mistake,
  the worst it can do is change step counts. Revoke it on the Apple Health steps screen.

## 1. Create the token

In Kalo: **Goals → Apple Health steps → Create token**. Tap the copy button and paste the token into
the shortcut in step 2 (into the Authorization header). Kalo does not show it again. If it is lost,
revoke it and create another.

## 2. Build the shortcut

The shortcut sends **today's** total and **yesterday's** total each time it runs. Yesterday's is what
makes the last steps of a day arrive: steps walked after the evening run are sent by the next morning's
run. Sending a count Kalo already has changes nothing.

Open **Shortcuts** on the iPhone, tap **+** to make a new shortcut, name it e.g. "Send steps to Kalo",
and add these actions in order (search for each name in the action list).

### Today

1. **Find Health Samples**
   - Type: **Steps**
   - Add filter **Start Date** **is today**
   - **Group By: Day**. Health then returns the day's total the way the Health app counts it. Without
     grouping you get every raw sample, and steps recorded by both the iPhone and an Apple Watch can be
     counted twice.
   - Limit: off.
2. **Calculate Statistics**: **Sum** of *Health Samples*. With Group By Day there is one sample, so
   the sum is that total. Alternatively, use **Get Details of Health Samples** (Value), then Calculate
   Statistics.
3. **Round Number**: *Statistics* to **Ones Place**.
4. **If** *Rounded Number* **is greater than** `0`. (While the iPhone is locked Health cannot be read
   and the sum is 0: nothing is sent then.) Put steps 5 and 6 inside the If, before **Otherwise** /
   **End If** (leave Otherwise empty or delete it).
5. **Format Date**: *Current Date*, Date Format **Custom**, Format String **`yyyy-MM-dd`** (capital
   `MM` is the month; lower-case `mm` would be minutes).
6. **Get Contents of URL**:
   - URL: the one on the Apple Health steps screen, for example
     `https://<your-kalo>.vercel.app/api/v1/daily-activity/{date}/steps`. Delete `{date}` and put the
     **Formatted Date** variable there.
   - Tap **Show More**:
     - Method: **PUT**
     - Headers: add `Authorization` with the value `Bearer ` (with one space) followed by the token
       you copied. Add `Content-Type` = `application/json` too if Shortcuts did not add it.
     - Request Body: **JSON**. Add a field: type **Number**, key `steps`, value **Rounded Number**.

### Yesterday

7. **Adjust Date**: *Current Date*, **Subtract** `1` **days**.
8. Repeat steps 1–6 below it (select them and duplicate, then drag the copies below), with two changes:
   - Find Health Samples: **Start Date is on** *Adjusted Date* (instead of "is today").
   - Format Date: *Adjusted Date* (instead of Current Date).
   - In the copy, pick the copies' own variables (the second Rounded Number and Formatted Date).

Tap the play button to test. Each Get Contents of URL answers something like
`{"activity_date":"2026-11-15","steps":8123,"day_type":null,"workout_kcal":null}`.
Open Kalo: the steps show after its next sync.

| Result | Meaning |
| --- | --- |
| `{"detail":"invalid token"}` (401) | The token is wrong, revoked, or `Bearer ` is missing. |
| 422 with `that day has not started yet` | The date is ahead of the timezone Kalo has for you. Check Format Date; after travelling to another time zone, open Kalo once so it updates its timezone. |
| 422 about `steps` | The body is not `{"steps": <number>}`: check the JSON field's key and type. |
| 404 | The URL is wrong (check `/api/v1/daily-activity/<date>/steps`), or the server does not serve the API on that address. The URL works on the public Vercel deployment, which serves the API on its own host (`SERVE_API_PUBLICLY`). Through the older ngrok tunnel only ChatGPT's routes are public, so this route answers 404 there. |

## 3. Run it every day

1. In Shortcuts, tap **Automation**, then **+** (or **Create Personal Automation**, the first time).
2. Choose **Time of Day**: **07:00**, Repeat **Daily**. Tap **Next**.
3. Choose **Run Immediately** (not "Run After Confirmation") and turn off **Notify When Run**.
4. Pick the "Send steps to Kalo" shortcut. Tap **Done**.
5. Make a second automation the same way at **21:00**.

The 07:00 run sends yesterday's final count (the phone is usually unlocked by then); the 21:00 run sends
most of today's. Add more times (e.g. 12:00 and 17:00) to see steps during the day. A run while the
iPhone is locked may read nothing; it then sends nothing and a later run catches up.

## Sources and what still needs an iPhone

Checked against Apple's Shortcuts User Guide (iOS 26):

- Personal automations, "Time of Day" with Repeat Daily/Weekly/Monthly:
  [Intro to personal automation](https://support.apple.com/guide/shortcuts/apd690170742/ios),
  [Create a new personal automation](https://support.apple.com/guide/shortcuts/apdfbdbd7123/ios),
  [Event triggers](https://support.apple.com/guide/shortcuts/apd932ff833f/ios).
- Get Contents of URL: Show More reveals the method (GET, POST, PUT, PATCH, DELETE); PUT adds a
  Request Body of JSON, Form or File:
  [Request your first API](https://support.apple.com/guide/shortcuts/apd58d46713f/ios).

Not found in Apple's guide (it has no reference for individual actions), so taken from Matthew
Cassinelli's action reference ([Find Health Samples](https://matthewcassinelli.com/actions/find-health-samples/):
Type, Start Date "is today", Group By Day, Limit) and community answers: the exact names
**Calculate Statistics**, **Round Number**, **If** (is greater than), **Adjust Date**, **Format Date**
(Custom format string), the Start Date filter **is on** a date variable, the **Headers**
section of Get Contents of URL, and the labels **Run Immediately** / **Notify When Run** (Apple's guide
only says an automation can be changed to run without asking). Confirm these on an iPhone with
iOS 18 or 26, that the grouped total matches the Health app's step count for the day, and that a
run while the phone is locked sends nothing rather than failing loudly.
