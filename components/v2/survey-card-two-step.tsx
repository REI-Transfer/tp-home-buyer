"use client"

// Two-step lead form. Rendered ONLY when the client's build sets
// NEXT_PUBLIC_TWO_STEP_FORM=1 (see SurveyCard in survey-card.tsx). Ported from
// the reviewed two-step forms in bobby-buys-homes and 606-home-buyers-llc.
//
// Stage 1 (no progress bar, one question per screen):
//   address → legal owner → listed on market → contact details
//   Contact submit fires NO pixel event (LeadEarly removed) and POSTs
//   lead_stage='early' to /api/submit (max 4s wait), then moves to Stage 2.
// Stage 2 (progress bar): the remaining questions in the one-step form's order.
//   The final answer submits lead_stage='complete' with the SAME scoring,
//   Lead vs LeadLowIntent event, payload and /thank-you redirect as the
//   one-step form, plus lead_stage and stage1_event_id.
// Hard DQs in Stage 1 (out of area, not owner, listed) stop BEFORE contact
// details: no early POST, no LeadEarly. Hard DQs in Stage 2 POST
// lead_stage='disqualified' (no pixel event) so n8n does not forward the
// partial lead, then show the block screen.

import { useState, useRef, useEffect, type ReactNode } from "react"
import { Home, ArrowRight, ArrowLeft, ArrowDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { captureTrackingData, getIPAddress, readGfSid } from "@/lib/tracking"
import { Input } from "@/components/ui/input"
import { AddressAutocomplete, type AddressDetails } from "@/components/survey/address-autocomplete"
import { isAddressInServiceArea } from "@/lib/service-area"
import type { SurveyCardProps } from "@/components/v2/survey-card"
import {
  type SurveyData,
  PROPERTY_TYPE_OPTIONS,
  LEGAL_OWNER_OPTIONS,
  OWNERSHIP_LENGTH_OPTIONS,
  LISTED_OPTIONS,
  TIMELINE_OPTIONS,
  CONDITION_OPTIONS,
  REASON_OPTIONS,
  calculateLeadScore,
  isQualifiedForMeta,
  leadQuality,
  disqualifyReasonFor,
  formatPhoneNumber,
  validatePhone,
  validateEmail,
  validateName,
  DisqualifiedScreen,
  SubmittedScreen,
} from "@/components/v2/survey-card-shared"

const STAGE1_STEPS = 4 // 1=address, 2=owner, 3=listed, 4=contact
type Stage2Field = "propertyType" | "ownershipLength" | "timeline" | "condition" | "reason"
// The one-step form's question order, minus the questions that moved to Stage 1.
const STAGE2_FIELDS: Stage2Field[] = ["propertyType", "ownershipLength", "timeline", "condition", "reason"]

// Hard disqualifiers: the same values the one-step form blocks on.
// Condo is a DQ (townhouse still qualifies).
const DQ_PROPERTY_TYPES = ["condo", "mobile-home", "land", "other"]
// Short ownership (under ~5 years: "1-3-years" = <3yr, "3-5-years" = 3-5yr)
const DQ_OWNERSHIP_LENGTHS = ["1-3-years", "3-5-years"]
// Listing hard-DQ (Elevate v2.51): only "No, never" (not-listed) passes. Stage 1.
const DQ_LISTED = ["listed-active", "not-sure", "listed-expired"]

// Cap how long the user waits on the early POST. The request is not aborted
// (the page does not navigate, so it keeps running in the background); the
// user just advances to Stage 2. A slow or failed early POST never blocks.
const EARLY_POST_MAX_WAIT_MS = 4000

type FbqFn = (...args: unknown[]) => void

// initialAddress set (hero / header already captured the address): Stage 1
// starts at the legal-owner question. Owner and listed are never skipped.
export function TwoStepSurveyCard({ initialAddress, brand }: SurveyCardProps) {
  const [stage, setStage] = useState<1 | 2>(1)
  const [stage1Step, setStage1Step] = useState(initialAddress ? 2 : 1)
  const [stage2Step, setStage2Step] = useState(1) // 1..STAGE2_FIELDS.length
  const totalStage2Steps = STAGE2_FIELDS.length

  const [surveyData, setSurveyData] = useState<SurveyData>({
    address: initialAddress || "",
    city: "",
    state: "",
    zip: "",
    propertyType: "",
    isLegalOwner: "",
    ownershipLength: "",
    listedOnMarket: "",
    timeline: "",
    condition: "",
    reason: "",
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
  })
  const [tcpaConsent, setTcpaConsent] = useState(false)
  const [isSubmitted, setIsSubmitted] = useState(false)
  const [isDisqualified, setIsDisqualified] = useState(false)
  const [disqualifyReason, setDisqualifyReason] = useState("")
  const [addressVerified, setAddressVerified] = useState(!!initialAddress)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [validationErrors, setValidationErrors] = useState<{[key: string]: string}>({})
  const formStartTime = useRef<number>(Date.now())
  const trackingRef = useRef(captureTrackingData())
  const stage1EventIdRef = useRef<string>("")
  const completeSentRef = useRef(false)
  // Set as soon as a hard-DQ answer is clicked, so a quick second click can't
  // advance (or submit) during the 300ms before the block screen appears.
  const dqPendingRef = useRef(false)
  const excellentPass = process.env.NEXT_PUBLIC_EXCELLENT_CONDITION_PASS === 'true'
  const leadSource = process.env.NEXT_PUBLIC_LEAD_SOURCE || `${brand.companyName} - Survey`
  useEffect(() => {
    getIPAddress().then((ip) => { trackingRef.current.ip = ip })
  }, [])
  const [honeypot, setHoneypot] = useState("")

  const disqualify = (reason: string) => {
    dqPendingRef.current = true
    setTimeout(() => { setDisqualifyReason(reason); setIsDisqualified(true) }, 300)
  }

  // ============================================================
  // STAGE 1
  // ============================================================

  const handleAddressSelect = (address: string, details: AddressDetails) => {
    const state = details.state?.toUpperCase() || ""
    const city = details.city || ""
    const zip = details.zip || ""
    setSurveyData({ ...surveyData, address, city, state, zip })

    // Same env-driven service-area gate as the one-step form.
    if (isAddressInServiceArea(details)) {
      setAddressVerified(true)
      setTimeout(() => { setStage1Step(2) }, 300)
      return
    }

    setAddressVerified(false)
    disqualify("outsideArea")
  }

  const handleAddressContinue = () => {
    if (surveyData.address.trim().length > 0 && addressVerified) setStage1Step(2)
  }

  const handleOwnerSelect = (value: string) => {
    setSurveyData({ ...surveyData, isLegalOwner: value })
    if (value === "no") { disqualify("notOwner"); return }
    setTimeout(() => { if (!dqPendingRef.current) setStage1Step(3) }, 300)
  }

  const handleListedSelect = (value: string) => {
    setSurveyData({ ...surveyData, listedOnMarket: value })
    if (DQ_LISTED.includes(value)) { disqualify("listed"); return }
    setTimeout(() => { if (!dqPendingRef.current) setStage1Step(4) }, 300)
  }

  const handleStage1Back = () => {
    if (stage1Step > 1) setStage1Step(stage1Step - 1)
  }

  // Contact submit: validate → anti-bot → early POST (no pixel event) → Stage 2
  const handleContactSubmit = async () => {
    const errors: {[key: string]: string} = {}
    const firstNameCheck = validateName(surveyData.firstName)
    if (!firstNameCheck.valid) errors.firstName = firstNameCheck.msg
    const lastNameCheck = validateName(surveyData.lastName)
    if (!lastNameCheck.valid) errors.lastName = lastNameCheck.msg
    const emailCheck = validateEmail(surveyData.email)
    if (!emailCheck.valid) errors.email = emailCheck.msg
    const phoneCheck = validatePhone(surveyData.phone)
    if (!phoneCheck.valid) errors.phone = phoneCheck.msg
    if (!tcpaConsent) errors.tcpaConsent = "Please check the box to continue."

    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors)
      return
    }
    setValidationErrors({})

    // Anti-bot: too-fast submit or honeypot tripped → fake success, nothing sent
    if (Date.now() - formStartTime.current < 3000) { setIsSubmitted(true); return }
    if (honeypot) { setIsSubmitted(true); return }

    setIsSubmitting(true)

    const earlyEventId = `lead-early-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
    stage1EventIdRef.current = earlyEventId

    try {
      const payload = {
        lead_stage: 'early',
        firstName: surveyData.firstName.trim(),
        lastName: surveyData.lastName.trim(),
        email: surveyData.email,
        phone: surveyData.phone,
        address: surveyData.address,
        city: surveyData.city,
        state: surveyData.state,
        zip: surveyData.zip,
        isLegalOwner: surveyData.isLegalOwner,
        listedOnMarket: surveyData.listedOnMarket,
        tcpa_consent: tcpaConsent,
        source: `${leadSource} (Stage 1)`,
        submittedAt: new Date().toISOString(),
        meta_event_id: earlyEventId,
        meta_event_name: 'LeadEarly',
        meta_value: 0,
        gf_sid: readGfSid(),
        ...trackingRef.current,
      }
      const post = fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => undefined)
      await Promise.race([post, new Promise((resolve) => setTimeout(resolve, EARLY_POST_MAX_WAIT_MS))])
    } catch {
      // a failed early POST must not block the user
    }

    setIsSubmitting(false)
    setStage(2)
    setStage2Step(1)
  }

  // ============================================================
  // STAGE 2
  // ============================================================

  // Final submit: scoring, qualification, event naming, payload, sessionStorage
  // bridge and redirect are the one-step form's; only lead_stage and
  // stage1_event_id are added.
  const submitComplete = async (finalData: SurveyData) => {
    if (completeSentRef.current || dqPendingRef.current) return

    // Anti-bot (same guards the one-step form runs on its final submit)
    const timeSpent = Date.now() - formStartTime.current
    if (timeSpent < 3000) { setIsSubmitted(true); return }
    if (honeypot) { setIsSubmitted(true); return }

    completeSentRef.current = true
    setIsSubmitting(true)

    try {
      const score = calculateLeadScore(finalData)
      const quality = leadQuality(score)
      // Excellent / move-in-ready condition is NOT a Meta-qualifying lead:
      // capture it for the client, but never fire the real "Lead" pixel event.
      const isExcellentCondition = finalData.condition === 'excellent'
      const qualified = isQualifiedForMeta(finalData) && (excellentPass || !isExcellentCondition)
      const dqReason = qualified ? null : disqualifyReasonFor(finalData)
      const eventId = `lead-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
      const payload = {
        ...finalData,
        ...trackingRef.current,
        source: leadSource,
        submittedAt: new Date().toISOString(),
        qualified,
        lead_score: score,
        lead_quality: quality,
        disqualify_reason: dqReason,
        meta_event_id: eventId,
        meta_event_name: qualified ? 'Lead' : 'LeadLowIntent',
        meta_value: qualified ? score * 25 : 0,
        lead_stage: 'complete',
        stage1_event_id: stage1EventIdRef.current,
      }
      // Fire weighted Meta Pixel event (browser-side; CAPI is a separate later phase)
      if (typeof window !== 'undefined' && (window as { fbq?: FbqFn }).fbq) {
        const fbq = (window as { fbq: FbqFn }).fbq
        if (qualified) {
          fbq('track', 'Lead', {
            value: score * 25, currency: 'USD',
            content_name: `${brand.companyName} Survey`, content_category: 'real_estate',
            lead_score: score, lead_quality: quality,
          }, { eventID: eventId })
        } else {
          fbq('trackCustom', 'LeadLowIntent', {
            content_name: `${brand.companyName} Survey`, content_category: 'real_estate',
            disqualify_reason: dqReason, lead_score: score,
          }, { eventID: eventId })
        }
      }
      const res = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        console.error('Submit failed:', res.status, await res.text())
      }
    } catch (e) {
      console.error('Submit error:', e)
    }

    // Persist lead data for thank-you page book offer
    try {
      sessionStorage.setItem('leadData', JSON.stringify({
        firstName: finalData.firstName,
        lastName: finalData.lastName,
        email: finalData.email,
        phone: finalData.phone,
        address: finalData.address,
        city: finalData.city,
        state: finalData.state,
        zip: finalData.zip,
      }))
      // Bridge the property condition to the thank-you page so its Lead
      // pixel fire can suppress excellent / move-in-ready leads.
      sessionStorage.setItem('lead_condition', finalData.condition)
    } catch {}

    window.location.href = '/thank-you'
  }

  const stage2DisqualifyReason = (field: Stage2Field, value: string): string | null => {
    if (field === "propertyType" && DQ_PROPERTY_TYPES.includes(value)) return "propertyType"
    if (field === "ownershipLength" && DQ_OWNERSHIP_LENGTHS.includes(value)) return "shortOwnership"
    // Move-in ready / excellent condition. NEXT_PUBLIC_EXCELLENT_CONDITION_PASS=true turns it off.
    if (field === "condition" && value === "excellent" && !excellentPass) return "excellentCondition"
    return null
  }

  // Stage-2 hard DQ: tell n8n this seller was disqualified, so the partial-lead
  // follow-up does not forward them to the client CRM. No pixel event; the
  // server route skips the GoFunnel forward for this stage.
  const sendDisqualified = (reason: string, answers: SurveyData) => {
    try {
      void fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lead_stage: 'disqualified',
          firstName: answers.firstName.trim(),
          lastName: answers.lastName.trim(),
          email: answers.email,
          phone: answers.phone,
          address: answers.address,
          city: answers.city,
          state: answers.state,
          zip: answers.zip,
          isLegalOwner: answers.isLegalOwner,
          listedOnMarket: answers.listedOnMarket,
          propertyType: answers.propertyType,
          ownershipLength: answers.ownershipLength,
          timeline: answers.timeline,
          condition: answers.condition,
          reason: answers.reason,
          qualified: false,
          disqualify_reason: reason,
          source: `${leadSource} (Stage 2 disqualified)`,
          submittedAt: new Date().toISOString(),
          stage1_event_id: stage1EventIdRef.current,
          ...trackingRef.current,
        }),
      }).catch(() => undefined)
    } catch {
      // never block the disqualify screen
    }
  }

  const handleStage2OptionSelect = (field: Stage2Field, value: string) => {
    const next = { ...surveyData, [field]: value }
    setSurveyData(next)

    const dq = stage2DisqualifyReason(field, value)
    if (dq) { sendDisqualified(dq, next); disqualify(dq); return }

    setTimeout(() => {
      if (dqPendingRef.current) return
      if (stage2Step < totalStage2Steps) {
        setStage2Step(stage2Step + 1)
      } else {
        void submitComplete(next)
      }
    }, 300)
  }

  // Back stops at the first Stage-2 question: the early lead is already sent.
  const handleStage2Back = () => {
    if (stage2Step > 1) setStage2Step(stage2Step - 1)
  }

  // ============================================================
  // RENDER HELPERS
  // ============================================================
  const renderOptionButton = (
    option: { id: string; label: string; desc?: string },
    selectedValue: string,
    onClick: () => void
  ) => (
    <button
      key={option.id}
      onClick={onClick}
      className={`w-full rounded-xl border px-4 py-3 md:px-5 md:py-4 text-left text-base md:text-lg font-medium transition-all ${
        selectedValue === option.id
          ? "border-[#1B2A4A] bg-[#1B2A4A]/10 text-[#0F1D2F]"
          : "border-[#E2E8F0] bg-white text-[#0F1D2F] hover:border-[#1B2A4A]/50 hover:bg-[#F5F7FA]"
      }`}
    >
      {option.desc ? (
        <>
          <span className="block">{option.label}</span>
          <span className="mt-0.5 block text-sm font-normal text-[#5A6B7D]">{option.desc}</span>
        </>
      ) : (
        option.label
      )}
    </button>
  )

  const renderQuestion = (title: string, subtitle: string, options: ReactNode, grid = false) => (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-xl md:text-2xl font-semibold text-[#0F1D2F]">{title}</h2>
        <p className="mt-1 text-base text-[#5A6B7D]">{subtitle}</p>
      </div>
      <div className={grid ? "grid grid-cols-2 gap-2" : "flex flex-col gap-2"}>
        {options}
      </div>
    </div>
  )

  const backButton = (onClick: () => void, disabled: boolean) => (
    <Button
      variant="ghost"
      onClick={onClick}
      disabled={disabled}
      className="text-[#5A6B7D] hover:text-[#0F1D2F] hover:bg-[#F5F7FA] text-base disabled:opacity-0"
    >
      <ArrowLeft className="mr-2 h-5 w-5" />
      Back
    </Button>
  )

  const inputClass = (field: string) =>
    `h-14 text-lg rounded-xl border-[#E2E8F0] bg-white text-[#0F1D2F] placeholder:text-[#94A3B8] focus:border-[#1B2A4A] focus:ring-[#1B2A4A]/20 ${validationErrors[field] ? "border-red-500" : ""}`

  if (isDisqualified) {
    return <DisqualifiedScreen reason={disqualifyReason} brand={brand} />
  }

  if (isSubmitted) {
    return <SubmittedScreen surveyData={surveyData} />
  }

  // ============================================================
  // STAGE 1 — one question per screen, NO progress bar
  // ============================================================
  if (stage === 1) {
    return (
      <div className="w-full max-w-2xl rounded-2xl border border-[#E2E8F0] bg-white p-4 md:p-6 shadow-lg">
        <div className="flex flex-col gap-3 md:gap-5">
          <div className="flex items-center gap-2">
            <Home className="h-5 w-5 text-[#1B2A4A]" />
            <span className="text-base text-[#5A6B7D]">Get your free cash offer</span>
          </div>

          {/* Step 1: Address */}
          {stage1Step === 1 && (
            <div className="flex flex-col gap-4">
              <div>
                <h2 className="text-xl md:text-2xl font-semibold text-[#0F1D2F]">What&apos;s your property address?</h2>
                <p className="mt-1 text-base text-[#5A6B7D]">Start typing and select your address from the dropdown.</p>
              </div>
              <div className="flex justify-center -mb-2">
                <ArrowDown className="h-6 w-6 text-[#1B2A4A] animate-bounce" />
              </div>
              <AddressAutocomplete
                value={surveyData.address}
                onChange={(address) => { setSurveyData({ ...surveyData, address }); setAddressVerified(false) }}
                onSelect={handleAddressSelect}
                placeholder="Start typing your address..."
              />
              <Button
                onClick={handleAddressContinue}
                disabled={!(surveyData.address.trim().length > 0 && addressVerified)}
                className="w-full h-14 bg-[#1B2A4A] text-white text-lg font-semibold rounded-xl hover:bg-[#131E36] disabled:opacity-40 transition-all shadow-md hover:shadow-lg"
              >
                Get My Cash Offer
                <ArrowRight className="ml-2 h-5 w-5" />
              </Button>
            </div>
          )}

          {/* Step 2: Legal Owner */}
          {stage1Step === 2 && renderQuestion(
            "Are you the legal homeowner?",
            "This helps us understand who we'll be working with.",
            LEGAL_OWNER_OPTIONS.map((o) => renderOptionButton(o, surveyData.isLegalOwner, () => handleOwnerSelect(o.id)))
          )}

          {/* Step 3: Listed on Market */}
          {stage1Step === 3 && renderQuestion(
            "Is the property currently listed?",
            "Let us know if the property is currently for sale.",
            LISTED_OPTIONS.map((o) => renderOptionButton(o, surveyData.listedOnMarket, () => handleListedSelect(o.id)))
          )}

          {/* Step 4: Contact Information */}
          {stage1Step === STAGE1_STEPS && (
            <div className="flex flex-col gap-4">
              <div>
                <h2 className="text-xl md:text-2xl font-semibold text-[#0F1D2F]">How can we reach you?</h2>
                <p className="mt-1 text-base text-[#5A6B7D]">We&apos;ll use this to send you your cash offer within 24 hours.</p>
              </div>
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Input
                      placeholder="First name"
                      autoComplete="given-name"
                      value={surveyData.firstName}
                      onChange={(e) => { setSurveyData({ ...surveyData, firstName: e.target.value }); setValidationErrors({ ...validationErrors, firstName: "" }) }}
                      className={inputClass("firstName")}
                    />
                    {validationErrors.firstName && <p className="mt-1 text-xs text-red-500">{validationErrors.firstName}</p>}
                  </div>
                  <div>
                    <Input
                      placeholder="Last name"
                      autoComplete="family-name"
                      value={surveyData.lastName}
                      onChange={(e) => { setSurveyData({ ...surveyData, lastName: e.target.value }); setValidationErrors({ ...validationErrors, lastName: "" }) }}
                      className={inputClass("lastName")}
                    />
                    {validationErrors.lastName && <p className="mt-1 text-xs text-red-500">{validationErrors.lastName}</p>}
                  </div>
                </div>
                <div>
                  <Input
                    type="email"
                    placeholder="Email address"
                    autoComplete="email"
                    value={surveyData.email}
                    onChange={(e) => { setSurveyData({ ...surveyData, email: e.target.value }); setValidationErrors({ ...validationErrors, email: "" }) }}
                    className={inputClass("email")}
                  />
                  {validationErrors.email && <p className="mt-1 text-xs text-red-500">{validationErrors.email}</p>}
                </div>
                <div>
                  <Input
                    type="tel"
                    placeholder="(888) 555-0000"
                    autoComplete="tel"
                    value={surveyData.phone}
                    onChange={(e) => { setSurveyData({ ...surveyData, phone: formatPhoneNumber(e.target.value) }); setValidationErrors({ ...validationErrors, phone: "" }) }}
                    maxLength={14}
                    className={inputClass("phone")}
                  />
                  {validationErrors.phone && <p className="mt-1 text-xs text-red-500">{validationErrors.phone}</p>}
                </div>

                {/* TCPA consent */}
                <label className={`flex items-start gap-3 rounded-xl border px-4 py-3 cursor-pointer transition-colors ${
                  validationErrors.tcpaConsent ? "border-red-500" : "border-[#E2E8F0] hover:border-[#1B2A4A]/40"
                }`}>
                  <input
                    type="checkbox"
                    checked={tcpaConsent}
                    onChange={(e) => {
                      setTcpaConsent(e.target.checked)
                      if (e.target.checked) setValidationErrors({ ...validationErrors, tcpaConsent: "" })
                    }}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-gray-300 accent-[#1B2A4A]"
                  />
                  <span className="text-xs text-[#5A6B7D] leading-snug">
                    By checking this box, I consent to receive calls and text messages (including autodialed) from {brand.companyName || "the company operating this website"} at the phone number provided. Consent is not a condition of any service. Standard message and data rates may apply. Reply STOP to opt out.
                  </span>
                </label>
                {validationErrors.tcpaConsent && <p className="-mt-2 text-xs text-red-500">{validationErrors.tcpaConsent}</p>}

                {/* Honeypot field */}
                <input
                  type="text"
                  name="website"
                  value={honeypot}
                  onChange={(e) => setHoneypot(e.target.value)}
                  className="absolute -left-[9999px] opacity-0 pointer-events-none"
                  tabIndex={-1}
                  autoComplete="off"
                />
              </div>
            </div>
          )}

          {/* Navigation: the address screen has its own big button; option
              screens auto-advance; the contact screen submits Stage 1. */}
          {stage1Step !== 1 && (
            <div className="flex items-center justify-between">
              {backButton(handleStage1Back, isSubmitting)}
              {stage1Step === STAGE1_STEPS && (
                <Button
                  onClick={handleContactSubmit}
                  disabled={isSubmitting || !(
                    surveyData.firstName.trim().length > 0 &&
                    surveyData.lastName.trim().length > 0 &&
                    surveyData.email.trim().length > 0 &&
                    surveyData.phone.trim().length > 0
                  )}
                  className="bg-[#1B2A4A] text-white text-lg px-8 py-3 hover:bg-[#131E36] disabled:opacity-50"
                >
                  {isSubmitting ? (
                    <span className="flex items-center gap-2">
                      <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-white" />
                      Submitting...
                    </span>
                  ) : (
                    <>
                      Get My Cash Offer
                      <ArrowRight className="ml-2 h-5 w-5" />
                    </>
                  )}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  // ============================================================
  // STAGE 2 — remaining questions, progress bar SHOWN
  // ============================================================
  const currentField = STAGE2_FIELDS[stage2Step - 1]
  return (
    <div className="w-full max-w-2xl rounded-2xl border border-[#E2E8F0] bg-white p-4 md:p-6 shadow-lg">
      <div className="flex flex-col gap-3 md:gap-5">
        {/* Progress indicator */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Home className="h-5 w-5 text-[#1B2A4A]" />
            <span className="text-base text-[#5A6B7D]">Step {stage2Step} of {totalStage2Steps}</span>
          </div>
          <div className="flex gap-1">
            {Array.from({ length: totalStage2Steps }).map((_, i) => (
              <div
                key={i}
                className={`h-1.5 w-6 rounded-full transition-colors ${
                  i < stage2Step ? "bg-[#1B2A4A]" : "bg-gray-200"
                }`}
              />
            ))}
          </div>
        </div>

        {currentField === "propertyType" && renderQuestion(
          "What type of property is it?",
          "Select the option that best describes your property.",
          PROPERTY_TYPE_OPTIONS.map((o) => renderOptionButton(o, surveyData.propertyType, () => handleStage2OptionSelect("propertyType", o.id)))
        )}

        {currentField === "ownershipLength" && renderQuestion(
          "When did you purchase the home?",
          "This helps us estimate your equity position.",
          OWNERSHIP_LENGTH_OPTIONS.map((o) => renderOptionButton(o, surveyData.ownershipLength, () => handleStage2OptionSelect("ownershipLength", o.id)))
        )}

        {currentField === "timeline" && renderQuestion(
          "How fast are you looking to sell?",
          "Select your ideal timeline for closing.",
          TIMELINE_OPTIONS.map((o) => renderOptionButton(o, surveyData.timeline, () => handleStage2OptionSelect("timeline", o.id)))
        )}

        {currentField === "condition" && renderQuestion(
          "What condition is the property in?",
          "Be honest. We buy houses in any condition.",
          CONDITION_OPTIONS.map((o) => renderOptionButton(o, surveyData.condition, () => handleStage2OptionSelect("condition", o.id)))
        )}

        {currentField === "reason" && renderQuestion(
          "What's your reason for selling?",
          "This helps us understand your situation better.",
          REASON_OPTIONS.map((o) => renderOptionButton(o, surveyData.reason, () => handleStage2OptionSelect("reason", o.id))),
          true
        )}

        {/* Navigation */}
        <div className="flex items-center justify-between">
          {backButton(handleStage2Back, stage2Step === 1 || isSubmitting)}
          {isSubmitting && (
            <span className="flex items-center gap-2 text-base text-[#5A6B7D]">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-[#1B2A4A]" />
              Submitting...
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
