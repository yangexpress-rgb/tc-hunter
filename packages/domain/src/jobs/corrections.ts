/**
 * Corrections from Yong's audit of every failing source (2026-11-17): each company was checked live
 * against the public job service the app reads. Applied once to each applicant's followed sources.
 */
export const SOURCE_FIX_VERSION = 1;

/** The verified place each company lists its jobs, with the count seen in the audit. */
export const VERIFIED_SOURCES: Array<{ company: string; url: string; audit: number; also?: string[] }> = [
  { company: "Accenture", url: "https://accenture.wd103.myworkdayjobs.com/AccentureCareers", audit: 2000 },
  { company: "Avanade", url: "https://accenture.wd103.myworkdayjobs.com/AvanadeCareers", audit: 680 },
  { company: "Automation Anywhere", url: "https://automationanywhere.wd5.myworkdayjobs.com/AutomationAnywhereJobs", audit: 33 },
  { company: "Cencora", url: "https://myhrabc.wd5.myworkdayjobs.com/Global", audit: 1037, also: ["AmerisourceBergen"] },
  { company: "Embecta", url: "https://embecta.wd1.myworkdayjobs.com/embectacareers", audit: 63 },
  { company: "Epicor", url: "https://epicorsoftware.wd5.myworkdayjobs.com/epicorjobs", audit: 37, also: ["Epicor Software"] },
  { company: "Genpact", url: "https://genpact.wd108.myworkdayjobs.com/External_Careers", audit: 1708 },
  { company: "Huron Consulting Group", url: "https://huron.wd1.myworkdayjobs.com/huroncareers", audit: 285, also: ["Huron"] },
  { company: "insightsoftware", url: "https://magnitudesoftware.wd1.myworkdayjobs.com/External", audit: 64 },
  { company: "Kyndryl", url: "https://kyndryl.wd5.myworkdayjobs.com/KyndrylProfessionalCareers", audit: 886 },
  { company: "Premier Inc.", url: "https://premierinc.wd1.myworkdayjobs.com/External_Professional", audit: 39, also: ["Premier"] },
  { company: "Red Hat", url: "https://redhat.wd5.myworkdayjobs.com/jobs", audit: 159 },
  { company: "Workday", url: "https://workday.wd5.myworkdayjobs.com/Workday", audit: 354 },
  { company: "Salesforce", url: "https://salesforce.wd12.myworkdayjobs.com/External_Career_Site", audit: 1570 },
  { company: "Databricks", url: "https://boards.greenhouse.io/databricks", audit: 901 },
  { company: "Veeva Systems", url: "https://jobs.lever.co/veeva", audit: 865, also: ["Veeva"] },
  { company: "West Monroe", url: "https://boards.greenhouse.io/westmonroe4", audit: 113, also: ["West Monroe Partners"] },
  { company: "SAP", url: "https://jobs.smartrecruiters.com/SAPITBusinessSysteme", audit: 958 },
];

/** Companies whose hiring systems have no public feed we read (Avature, Taleo, BrassRing, SuccessFactors, own portals). */
export const UNREADABLE_COMPANIES: Array<{ company: string; system: string; also?: string[] }> = [
  { company: "KPMG", system: "Avature" },
  { company: "Cognizant", system: "its own careers portal" },
  { company: "Coastal Cloud", system: "its own careers portal" },
  { company: "Deloitte", system: "Avature" },
  { company: "IBM", system: "its own careers portal (Avature)" },
  { company: "Infor", system: "its own careers portal" },
  { company: "Infosys", system: "its own careers portal" },
  { company: "Lenovo", system: "its own careers portal" },
  { company: "Pegasystems", system: "its own careers portal", also: ["Pega"] },
  { company: "Slalom", system: "its own careers portal" },
  { company: "TCS", system: "its own careers portal (iBegin)", also: ["Tata Consultancy Services"] },
];

export const unreadableReason = (company: string, system: string) =>
  `${company} lists its jobs on ${system}, which has no public feed we can read. Its jobs still come in through Adzuna and the other job sites.`;
