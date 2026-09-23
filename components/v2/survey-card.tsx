"use client"

import { useState, useRef, useEffect } from "react"
import { Home, ArrowRight, ArrowLeft, ArrowDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { captureTrackingData, getIPAddress } from "@/lib/tracking"
import { Input } from "@/components/ui/input"
import { AddressAutocomplete, type AddressDetails } from "@/components/survey/address-autocomplete"
import { isAddressInServiceArea } from "@/lib/service-area"
import type { Brand } from "@/lib/brand"
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
import { TwoStepSurveyCard } from "@/components/v2/survey-card-two-step"

export interface SurveyCardProps {
  initialAddress?: string
  brand: Brand
}

// Per-client switch (NEXT_PUBLIC_TWO_STEP_FORM, read at build time via
// lib/config -> brand.twoStepForm). OFF by default: every client without the
// switch gets the one-step form below, unchanged. ON: the two-step form in
// survey-card-two-step.tsx (early lead on contact details, full lead on finish).
export function SurveyCard(props: SurveyCardProps) {
  return props.brand.twoStepForm ? <TwoStepSurveyCard {...props} /> : <OneStepSurveyCard {...props} />
}

// The original one-step form (9 screens, one submit). Logic untouched.
function OneStepSurveyCard({ initialAddress, brand }: SurveyCardProps) {
  const [step, setStep] = useState(initialAddress ? 2 : 1)
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
  const [isSubmitted, setIsSubmitted] = useState(false)
  const [isDisqualified, setIsDisqualified] = useState(false)
  const [disqualifyReason, setDisqualifyReason] = useState("")
  const [addressVerified, setAddressVerified] = useState(!!initialAddress)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [validationErrors, setValidationErrors] = useState<{[key: string]: string}>({})
  const formStartTime = useRef<number>(Date.now())
  const trackingRef = useRef(captureTrackingData())
  const excellentPass = process.env.NEXT_PUBLIC_EXCELLENT_CONDITION_PASS === 'true'
  useEffect(() => {
    getIPAddress().then((ip) => { trackingRef.current.ip = ip })
  }, [])
  const [honeypot, setHoneypot] = useState("")

  const totalSteps = 9

  const handleNext = async () => {
    if (step === 9) {
      const errors: {[key: string]: string} = {}
      const firstNameCheck = validateName(surveyData.firstName)
      if (!firstNameCheck.valid) errors.firstName = firstNameCheck.msg
      const lastNameCheck = validateName(surveyData.lastName)
      if (!lastNameCheck.valid) errors.lastName = lastNameCheck.msg
      const emailCheck = validateEmail(surveyData.email)
      if (!emailCheck.valid) errors.email = emailCheck.msg
      const phoneCheck = validatePhone(surveyData.phone)
      if (!phoneCheck.valid) errors.phone = phoneCheck.msg

      if (Object.keys(errors).length > 0) {
        setValidationErrors(errors)
        return
      }

      const timeSpent = Date.now() - formStartTime.current
      if (timeSpent < 3000) { setIsSubmitted(true); return }
      if (honeypot) { setIsSubmitted(true); return }

      setIsSubmitting(true)

      try {
        const score = calculateLeadScore(surveyData)
        const quality = leadQuality(score)
        // Excellent / move-in-ready condition is NOT a Meta-qualifying lead:
        // capture it for the client, but never fire the real "Lead" pixel event.
        const isExcellentCondition = surveyData.condition === 'excellent'
        const qualified = isQualifiedForMeta(surveyData) && (excellentPass || !isExcellentCondition)
        const dqReason = qualified ? null : disqualifyReasonFor(surveyData)
        const eventId = `lead-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
        const payload = {
          ...surveyData,
          ...trackingRef.current,
          source: process.env.NEXT_PUBLIC_LEAD_SOURCE || `${brand.companyName} - Survey`,
          submittedAt: new Date().toISOString(),
          qualified,
          lead_score: score,
          lead_quality: quality,
          disqualify_reason: dqReason,
          meta_event_id: eventId,
          meta_event_name: qualified ? 'Lead' : 'LeadLowIntent',
          meta_value: qualified ? score * 25 : 0,
        }
        // Fire weighted Meta Pixel event (browser-side; CAPI is a separate later phase)
        if (typeof window !== 'undefined' && (window as { fbq?: (...args: unknown[]) => void }).fbq) {
          const fbq = (window as { fbq: (...args: unknown[]) => void }).fbq
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
          firstName: surveyData.firstName,
          lastName: surveyData.lastName,
          email: surveyData.email,
          phone: surveyData.phone,
          address: surveyData.address,
          city: surveyData.city,
          state: surveyData.state,
          zip: surveyData.zip,
        }))
        // Bridge the property condition to the thank-you page so its Lead
        // pixel fire can suppress excellent / move-in-ready leads.
        sessionStorage.setItem('lead_condition', surveyData.condition)
      } catch {}

      window.location.href = '/thank-you'
    } else if (step < totalSteps) {
      setStep(step + 1)
    }
  }

  const handleBack = () => {
    if (step > 1) setStep(step - 1)
  }

  const canProceed = () => {
    switch (step) {
      case 1: return surveyData.address.trim().length > 0 && addressVerified
      case 2: return surveyData.propertyType !== ""
      case 3: return surveyData.isLegalOwner !== ""
      case 4: return surveyData.ownershipLength !== ""
      case 5: return surveyData.listedOnMarket !== ""
      case 6: return surveyData.timeline !== ""
      case 7: return surveyData.condition !== ""
      case 8: return surveyData.reason !== ""
      case 9: return surveyData.firstName.trim().length > 0 && surveyData.lastName.trim().length > 0 && surveyData.email.trim().length > 0 && surveyData.phone.trim().length > 0
      default: return false
    }
  }

  const handleOptionSelect = (field: keyof SurveyData, value: string) => {
    setSurveyData({ ...surveyData, [field]: value })

    // Disqualify: property type (condo, mobile home, land, other — townhouse still qualifies)
    if (field === "propertyType" && ["condo", "mobile-home", "land", "other"].includes(value)) {
      setTimeout(() => { setDisqualifyReason("propertyType"); setIsDisqualified(true) }, 300)
      return
    }
    // Default hard-DQ: move-in ready / excellent condition (not a distressed/motivated seller)
    if (field === "condition" && value === "excellent" && !excellentPass) {
      setTimeout(() => { setDisqualifyReason("excellentCondition"); setIsDisqualified(true) }, 300)
      return
    }
    // Listing hard-DQ (Elevate v2.51): only "No, never" (not-listed) passes; active,
    // expired/cancelled, and "not sure" all block.
    if (field === "listedOnMarket" && ["listed-active", "not-sure", "listed-expired"].includes(value)) {
      setTimeout(() => { setDisqualifyReason("listed"); setIsDisqualified(true) }, 300)
      return
    }
    if (field === "isLegalOwner" && value === "no") {
      setTimeout(() => { setDisqualifyReason("notOwner"); setIsDisqualified(true) }, 300)
      return
    }
    // Default hard-DQ: short ownership (under ~5 years — real option ids: "1-3-years" = <3yr, "3-5-years" = 3-5yr)
    if (field === "ownershipLength" && ["1-3-years", "3-5-years"].includes(value)) {
      setTimeout(() => { setDisqualifyReason("shortOwnership"); setIsDisqualified(true) }, 300)
      return
    }

    setTimeout(() => { if (step < totalSteps) setStep(step + 1) }, 300)
  }

  const handleAddressSelect = (address: string, details: AddressDetails) => {
    const state = details.state?.toUpperCase() || ""
    const city = details.city || ""
    const zip = details.zip || ""
    setSurveyData({ ...surveyData, address, city, state, zip })

    // Env-driven service-area gate. Permissive when NEXT_PUBLIC_SERVICE_AREAS is
    // empty (accepts any address). addressVerified only flips true after passing.
    if (isAddressInServiceArea(details)) {
      setAddressVerified(true)
      setTimeout(() => { setStep(2) }, 300)
      return
    }

    setAddressVerified(false)
    setTimeout(() => { setDisqualifyReason("outsideArea"); setIsDisqualified(true) }, 300)
  }

  const renderOptionButton = (
    option: { id: string; label: string; desc?: string },
    selectedValue: string,
    field: keyof SurveyData
  ) => (
    <button
      key={option.id}
      onClick={() => handleOptionSelect(field, option.id)}
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

  if (isDisqualified) {
    return <DisqualifiedScreen reason={disqualifyReason} brand={brand} />
  }

  if (isSubmitted) {
    return <SubmittedScreen surveyData={surveyData} />
  }

  return (
    <div className="w-full max-w-2xl rounded-2xl border border-[#E2E8F0] bg-white p-4 md:p-6 shadow-lg">
      <div className="flex flex-col gap-3 md:gap-5">
        {/* Progress indicator */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Home className="h-5 w-5 text-[#1B2A4A]" />
            <span className="text-base text-[#5A6B7D]">Step {step} of {totalSteps}</span>
          </div>
          <div className="flex gap-1">
            {Array.from({ length: totalSteps }).map((_, i) => (
              <div
                key={i}
                className={`h-1.5 w-6 rounded-full transition-colors ${
                  i < step ? "bg-[#1B2A4A]" : "bg-gray-200"
                }`}
              />
            ))}
          </div>
        </div>

        {/* Step 1: Address */}
        {step === 1 && (
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
              onClick={handleNext}
              disabled={!canProceed()}
              className="w-full h-14 bg-[#1B2A4A] text-white text-lg font-semibold rounded-xl hover:bg-[#131E36] disabled:opacity-40 transition-all shadow-md hover:shadow-lg"
            >
              Get My Cash Offer
              <ArrowRight className="ml-2 h-5 w-5" />
            </Button>
          </div>
        )}

        {/* Step 2: Property Type */}
        {step === 2 && (
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-xl md:text-2xl font-semibold text-[#0F1D2F]">What type of property is it?</h2>
              <p className="mt-1 text-base text-[#5A6B7D]">Select the option that best describes your property.</p>
            </div>
            <div className="flex flex-col gap-2">
              {PROPERTY_TYPE_OPTIONS.map((option) => renderOptionButton(option, surveyData.propertyType, "propertyType"))}
            </div>
          </div>
        )}

        {/* Step 3: Legal Owner */}
        {step === 3 && (
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-xl md:text-2xl font-semibold text-[#0F1D2F]">Are you the legal homeowner?</h2>
              <p className="mt-1 text-base text-[#5A6B7D]">This helps us understand who we&apos;ll be working with.</p>
            </div>
            <div className="flex flex-col gap-2">
              {LEGAL_OWNER_OPTIONS.map((option) => renderOptionButton(option, surveyData.isLegalOwner, "isLegalOwner"))}
            </div>
          </div>
        )}

        {/* Step 4: Ownership Length */}
        {step === 4 && (
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-xl md:text-2xl font-semibold text-[#0F1D2F]">When did you purchase the home?</h2>
              <p className="mt-1 text-base text-[#5A6B7D]">This helps us estimate your equity position.</p>
            </div>
            <div className="flex flex-col gap-2">
              {OWNERSHIP_LENGTH_OPTIONS.map((option) => renderOptionButton(option, surveyData.ownershipLength, "ownershipLength"))}
            </div>
          </div>
        )}

        {/* Step 5: Listed on Market */}
        {step === 5 && (
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-xl md:text-2xl font-semibold text-[#0F1D2F]">Is the property currently listed?</h2>
              <p className="mt-1 text-base text-[#5A6B7D]">Let us know if the property is currently for sale.</p>
            </div>
            <div className="flex flex-col gap-2">
              {LISTED_OPTIONS.map((option) => renderOptionButton(option, surveyData.listedOnMarket, "listedOnMarket"))}
            </div>
          </div>
        )}

        {/* Step 6: Timeline */}
        {step === 6 && (
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-xl md:text-2xl font-semibold text-[#0F1D2F]">How fast are you looking to sell?</h2>
              <p className="mt-1 text-base text-[#5A6B7D]">Select your ideal timeline for closing.</p>
            </div>
            <div className="flex flex-col gap-2">
              {TIMELINE_OPTIONS.map((option) => renderOptionButton(option, surveyData.timeline, "timeline"))}
            </div>
          </div>
        )}

        {/* Step 7: Condition */}
        {step === 7 && (
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-xl md:text-2xl font-semibold text-[#0F1D2F]">What condition is the property in?</h2>
              <p className="mt-1 text-base text-[#5A6B7D]">Be honest. We buy houses in any condition.</p>
            </div>
            <div className="flex flex-col gap-2">
              {CONDITION_OPTIONS.map((option) => renderOptionButton(option, surveyData.condition, "condition"))}
            </div>
          </div>
        )}

        {/* Step 8: Reason */}
        {step === 8 && (
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-xl md:text-2xl font-semibold text-[#0F1D2F]">What&apos;s your reason for selling?</h2>
              <p className="mt-1 text-base text-[#5A6B7D]">This helps us understand your situation better.</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {REASON_OPTIONS.map((option) => renderOptionButton(option, surveyData.reason, "reason"))}
            </div>
          </div>
        )}

        {/* Step 9: Contact Information */}
        {step === 9 && (
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-xl md:text-2xl font-semibold text-[#0F1D2F]">Almost done. How can we reach you?</h2>
              <p className="mt-1 text-base text-[#5A6B7D]">We&apos;ll use this to send you your cash offer within 24 hours.</p>
            </div>
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Input
                    placeholder="First name"
                    value={surveyData.firstName}
                    onChange={(e) => { setSurveyData({ ...surveyData, firstName: e.target.value }); setValidationErrors({ ...validationErrors, firstName: "" }) }}
                    className={`h-14 text-lg rounded-xl border-[#E2E8F0] bg-white text-[#0F1D2F] placeholder:text-[#94A3B8] focus:border-[#1B2A4A] focus:ring-[#1B2A4A]/20 ${validationErrors.firstName ? "border-red-500" : ""}`}
                  />
                  {validationErrors.firstName && <p className="mt-1 text-xs text-red-500">{validationErrors.firstName}</p>}
                </div>
                <div>
                  <Input
                    placeholder="Last name"
                    value={surveyData.lastName}
                    onChange={(e) => { setSurveyData({ ...surveyData, lastName: e.target.value }); setValidationErrors({ ...validationErrors, lastName: "" }) }}
                    className={`h-14 text-lg rounded-xl border-[#E2E8F0] bg-white text-[#0F1D2F] placeholder:text-[#94A3B8] focus:border-[#1B2A4A] focus:ring-[#1B2A4A]/20 ${validationErrors.lastName ? "border-red-500" : ""}`}
                  />
                  {validationErrors.lastName && <p className="mt-1 text-xs text-red-500">{validationErrors.lastName}</p>}
                </div>
              </div>
              <div>
                <Input
                  type="email"
                  placeholder="Email address"
                  value={surveyData.email}
                  onChange={(e) => { setSurveyData({ ...surveyData, email: e.target.value }); setValidationErrors({ ...validationErrors, email: "" }) }}
                  className={`h-14 text-lg rounded-xl border-[#E2E8F0] bg-white text-[#0F1D2F] placeholder:text-[#94A3B8] focus:border-[#1B2A4A] focus:ring-[#1B2A4A]/20 ${validationErrors.email ? "border-red-500" : ""}`}
                />
                {validationErrors.email && <p className="mt-1 text-xs text-red-500">{validationErrors.email}</p>}
              </div>
              <div>
                <Input
                  type="tel"
                  placeholder="(888) 555-0000"
                  value={surveyData.phone}
                  onChange={(e) => { setSurveyData({ ...surveyData, phone: formatPhoneNumber(e.target.value) }); setValidationErrors({ ...validationErrors, phone: "" }) }}
                  maxLength={14}
                  className={`h-14 text-lg rounded-xl border-[#E2E8F0] bg-white text-[#0F1D2F] placeholder:text-[#94A3B8] focus:border-[#1B2A4A] focus:ring-[#1B2A4A]/20 ${validationErrors.phone ? "border-red-500" : ""}`}
                />
                {validationErrors.phone && <p className="mt-1 text-xs text-red-500">{validationErrors.phone}</p>}
              </div>
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

        {/* Navigation buttons */}
        {step !== 1 && (
        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            onClick={handleBack}
            disabled={step === 1}
            className="text-[#5A6B7D] hover:text-[#0F1D2F] hover:bg-[#F5F7FA] text-base disabled:opacity-0"
          >
            <ArrowLeft className="mr-2 h-5 w-5" />
            Back
          </Button>
          <Button
            onClick={handleNext}
            disabled={!canProceed() || isSubmitting}
            className="bg-[#1B2A4A] text-white text-lg px-8 py-3 hover:bg-[#131E36] disabled:opacity-50"
          >
            {isSubmitting ? (
              <span className="flex items-center gap-2">
                <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-white" />
                Submitting...
              </span>
            ) : (
              <>
                {step === totalSteps ? "Get My Cash Offer" : "Continue"}
                {step !== totalSteps && <ArrowRight className="ml-2 h-5 w-5" />}
              </>
            )}
          </Button>
        </div>
        )}
      </div>
    </div>
  )
}
