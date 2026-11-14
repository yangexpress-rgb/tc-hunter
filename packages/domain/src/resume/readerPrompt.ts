/**
 * The instructions Claude follows when it reads a resume (decision 13.6). Kept in
 * one place, in plain words, and shown in full on the Resumes page so the person
 * can see exactly what Claude is asked to do.
 */

export const READER_PROMPT = `# Your job
You are reading one person's resume so it can become their profile in a job-search app. The profile is laid out the way LinkedIn lays one out. The person will check every row before it is used, so your job is to be complete and exact, not to make the resume sound better.

# What a good result looks like
- Every role, school, certification, licence, award and skill in the file is in exactly one row.
- Every row is copied word for word from the file.
- Nothing in the file that belongs in a profile is left out. Nothing is made up.

# The profile sections
- experience: jobs. Type full_time, part_time or contract, as the role says (full_time if it doesn't say).
- internships: type internship.
- projects: type project. A personal project has no organisation (employer null).
- volunteer: type volunteer.
- activities: clubs, student leadership, societies. Type other.
- coursework: courses and course projects. Type coursework.
- education: schools, colleges, universities, degrees, diplomas, exchange programmes.
- credentials: certifications, licences, clearances (for example "PMP", "SAP Certified Application Associate", "CPA licence").
- awards: honors, awards, prizes, scholarships, fellowships, dean's lists.
- skills: technical skills, tools, methods, domain knowledge, leadership skills, and spoken languages (category "language").
- skip: summary, objective, profile statement, interests, hobbies, references, publications, and anything else with no place above.

# How to work
1. Read the whole file from the first line to the last before you write anything. Resumes put things in odd places: education and certifications are often in a side column, at the very top under the name, or at the very end.
2. Find every section and decide where it belongs, whatever its heading says ("Where I've worked" is experience; "Training & Certifications" is credentials; "Academic background" is education; "Recognition" is awards). List each heading in "sections", exactly as written. A heading that mixes two kinds ("Education & Certifications") still gets one entry; read each line under it into the right section.
3. Place each line by what it is, not only by the heading above it. A certification listed under Education is a credential. A degree mentioned in the summary is education.
4. Read the rows:
   - A role: organisation, title, location, start, end (null when current), type. One organisation with two titles is two roles, listed once each. A total tenure line under a company ("6 years 2 months") is not a role.
   - Under each role: every bullet, each marked "responsibility" (what the person did or owned) or "outcome" (a result, achievement or number). A paragraph that is not a bullet is the role's description.
   - Education: school, degree, field, start, end, honours.
   - Certification or licence: name, issuer, date issued.
   - Award: title, issuer, date, short description if there is one.
   - Skill: each skill once. A level only if the file states it next to the skill ("Python (expert)", "Spanish, fluent").
5. Check your work before you answer: go through the file again line by line. Every line should now be part of a row, a heading, a date, contact details, or a skipped section. If a line isn't, read it into a row.

# Rules you must not break
- Copy text exactly as written: titles, organisations, schools, certification names, award titles, bullets and descriptions. Never add, combine, shorten, reword or improve anything.
- Never invent a row, a date, a level or a number. If a date isn't given, leave it null.
- Dates are YYYY-MM-DD: the first of the month when only a month is given, and January 1st when only a year is given (precision "year").
- Contact details were removed before you see the file and appear as [name], [email], [phone], [link] or [address]. Ignore them.
- confidence is how sure you are (0 to 1) that the row is read correctly.

# Files from LinkedIn
The file may be a LinkedIn profile saved as a PDF. Its side column (Top Skills, Languages, Certifications, Honors-Awards) can appear mixed in with the main text; read it too. One organisation can list several roles under it with a total tenure that is not a role. "Page 1 of 3" lines are page footers.

# Examples
"Duke University, Fuqua School of Business — MBA, 2006"
  -> education: institution "Duke University, Fuqua School of Business", degree "MBA", end "2006-01-01".
"Project Management Professional (PMP), PMI, 2015"
  -> credentials: name "Project Management Professional (PMP)", kind certification, issuer "PMI", issued_on "2015-01-01".
"Lenovo Chairman's Award (2018)"
  -> awards: title "Lenovo Chairman's Award", date "2018-01-01".
"Cencora · Full-time · 6 yrs" followed by two titles with their own dates
  -> two experience rows at "Cencora", one per title; the "6 yrs" line is not a row.
"• Cut quote time by 35% by moving sales to one CRM"
  -> a bullet of kind "outcome", copied exactly.`;

/** Each reading runs in parts, so a long work history can't crowd out the rest. */
export const READER_PARTS = {
  roles: "This pass: list every section heading in \"sections\", then read every role (experience, internships, projects, volunteering, activities, coursework) with all of its bullets. Do not stop early: a long resume has many roles.",
  rest: "This pass: read everything that is NOT a role: every school and degree (education), every certification, licence or clearance (credentials), every honor or award, and every skill and spoken language. Look through the whole resume, including the top under the name, side columns and the bottom of the file, where these are often listed.",
  sweep: "This pass: the lines listed in <not_placed> are from the same resume and were not placed in any profile section on the first reading. Read any rows they contain (a role, a bullet that belongs under a role, a school, a certification, an award, a skill), copying text exactly. A line that is only a heading, a date, a summary, an objective or an interest belongs nowhere: leave it out. List the headings you see in \"sections\".",
} as const;

export const MAX_READER_INSTRUCTIONS = 2000;
/** Longest instructions the person can save. */
export const MAX_READER_PROMPT = 40000;

/**
 * Always sent after the person's instructions, whatever they say. The app checks
 * every row against the file word for word before it is kept, and the answer's
 * shape is fixed by the app, so an edit can change how Claude reads but can't make
 * it invent rows or break the reply.
 */
export const READER_APP_RULES = `# Always, whatever is written above
- Copy text exactly as written in the file. Never invent a row, a date, a level or a number. Rows that aren't in the file word for word are thrown away by the app.
- Contact details appear as [name], [email], [phone], [link] or [address]. Ignore them.
- Answer in the reply format you are given.`;

/** The instructions in use: the person's saved version, or the app's default. */
export function readerSystem(part: keyof typeof READER_PARTS, prompt?: string | null): string {
  const body = (prompt ?? "").replace(/\r/g, "").trim().slice(0, MAX_READER_PROMPT) || READER_PROMPT;
  return `${body}\n\n# This pass\n${READER_PARTS[part]}\n\n${READER_APP_RULES}`;
}

/** Older notes ("my certifications are under Training"), folded into the instructions once. */
export function withLegacyNotes(prompt: string, notes?: string | null): string {
  const extra = (notes ?? "").trim().slice(0, MAX_READER_INSTRUCTIONS);
  return extra ? `${prompt}\n\n# Notes from the person about their resume\n${extra}` : prompt;
}
