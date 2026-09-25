"use client"

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { Input } from "@/components/ui/input"
import { MapPin } from "lucide-react"
import { getAddressBounds, type LatLngBoundsLiteral } from "@/lib/address-bounds"

export interface AddressDetails {
  formattedAddress: string
  state?: string
  city?: string
  county?: string
  zip?: string
  lat?: number
  lng?: number
}

interface AddressAutocompleteProps {
  value: string
  onChange: (address: string) => void
  onSelect: (address: string, details: AddressDetails) => void
  placeholder?: string
  bounds?: LatLngBoundsLiteral
  className?: string
}

export interface AddressAutocompleteHandle {
  /**
   * For when the visitor typed an address but never tapped a suggestion.
   * Looks up the top suggestion and runs it through the same onSelect as a tap.
   * Resolves true if an address was selected; false (with an inline message) if not.
   */
  resolveTypedAddress: () => Promise<boolean>
}

declare global {
  interface Window {
    google: typeof google
    initGooglePlaces: () => void
  }
}

const BLOCKED_ADDRESSES = [
  "9809 newhall rd",
]

function isBlockedAddress(formattedAddress: string): boolean {
  const lower = formattedAddress.toLowerCase()
  return BLOCKED_ADDRESSES.some(blocked => lower.includes(blocked))
}

const PLACE_FIELDS = ["formatted_address", "address_components", "geometry"]
const TAP_MESSAGE = "Please tap your address in the list so we can find it."
const EMPTY_MESSAGE = "Please enter your property address."
const LOOKUP_TIMEOUT_MS = 8000

// One Google Maps script per page, however many address boxes mount.
const PLACES_SCRIPT_ID = "google-places-script"
let placesLoader: Promise<void> | null = null

function loadGooglePlaces(): Promise<void> {
  if (window.google?.maps?.places) return Promise.resolve()
  if (placesLoader) return placesLoader
  placesLoader = new Promise<void>((resolve, reject) => {
    let script = document.getElementById(PLACES_SCRIPT_ID) as HTMLScriptElement | null
    if (!script) {
      script = document.createElement("script")
      script.id = PLACES_SCRIPT_ID
      script.src = `https://maps.googleapis.com/maps/api/js?key=${process.env.NEXT_PUBLIC_GOOGLE_PLACES_API_KEY}&libraries=places`
      script.async = true
      script.defer = true
      document.head.appendChild(script)
    }
    script.addEventListener("load", () => resolve())
    script.addEventListener("error", () => {
      placesLoader = null
      script?.remove()
      reject(new Error("Google Places failed to load"))
    })
  })
  return placesLoader
}

function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), LOOKUP_TIMEOUT_MS)),
  ])
}

export const AddressAutocomplete = forwardRef<AddressAutocompleteHandle, AddressAutocompleteProps>(function AddressAutocomplete({
  value,
  onChange,
  onSelect,
  placeholder = "Start typing your address...",
  bounds,
  className,
}, ref) {
  const inputRef = useRef<HTMLInputElement>(null)
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null)
  const [isLoaded, setIsLoaded] = useState(false)
  const [hint, setHint] = useState("")
  const resolvingRef = useRef<Promise<boolean> | null>(null)

  // Google's listener is attached once, so read the latest callbacks through refs.
  const onChangeRef = useRef(onChange)
  const onSelectRef = useRef(onSelect)
  onChangeRef.current = onChange
  onSelectRef.current = onSelect

  const searchBounds = useMemo(() => bounds ?? getAddressBounds(), [bounds])

  useEffect(() => {
    let cancelled = false
    loadGooglePlaces()
      .then(() => {
        if (cancelled) return
        setIsLoaded(true)
        initAutocomplete()
      })
      .catch(() => {})

    return () => {
      cancelled = true
      if (autocompleteRef.current) {
        google.maps.event.clearInstanceListeners(autocompleteRef.current)
      }
    }
  }, [])

  // The one path every selection goes through: a tapped suggestion, or a typed
  // address resolved to its top suggestion. Returns false if the place is unusable.
  const selectPlace = (place: google.maps.places.PlaceResult | null | undefined): boolean => {
    if (!place?.formatted_address) return false
    setHint("")
    // Block specific addresses
    if (isBlockedAddress(place.formatted_address)) {
      alert("Sorry, we are unable to provide an offer for this property at this time.")
      onChangeRef.current("")
      return true
    }
    // Extract address components
    let state = ""
    let city = ""
    let county = ""
    let zip = ""

    place.address_components?.forEach((component) => {
      if (component.types.includes("administrative_area_level_1")) {
        state = component.short_name // e.g., "MD", "VA", "DC"
      }
      if (component.types.includes("locality")) {
        city = component.long_name
      }
      if (component.types.includes("administrative_area_level_2")) {
        county = component.long_name
      }
      if (component.types.includes("postal_code")) {
        zip = component.short_name
      }
    })

    const loc = place.geometry?.location
    const details: AddressDetails = {
      formattedAddress: place.formatted_address,
      state,
      city,
      county,
      zip,
      lat: loc ? loc.lat() : undefined,
      lng: loc ? loc.lng() : undefined,
    }

    onChangeRef.current(place.formatted_address)
    onSelectRef.current(place.formatted_address, details)
    return true
  }

  const getTopPrediction = (input: string, sessionToken: google.maps.places.AutocompleteSessionToken) =>
    new Promise<google.maps.places.AutocompletePrediction | null>((resolve) => {
      const request: google.maps.places.AutocompletionRequest = {
        input,
        sessionToken,
        componentRestrictions: { country: "us" },
        types: ["address"],
      }
      if (searchBounds) request.locationRestriction = searchBounds
      new google.maps.places.AutocompleteService().getPlacePredictions(request, (predictions, status) => {
        resolve(status === google.maps.places.PlacesServiceStatus.OK && predictions?.length ? predictions[0] : null)
      })
    })

  const getPlaceDetails = (placeId: string, sessionToken: google.maps.places.AutocompleteSessionToken) =>
    new Promise<google.maps.places.PlaceResult | null>((resolve) => {
      new google.maps.places.PlacesService(document.createElement("div")).getDetails(
        { placeId, fields: PLACE_FIELDS, sessionToken },
        (place, status) => {
          resolve(status === google.maps.places.PlacesServiceStatus.OK ? place : null)
        }
      )
    })

  const askToTap = (message: string) => {
    setHint(message)
    // Keep them in the box; focusing lets Google show its suggestions again.
    inputRef.current?.focus()
  }

  const resolveTypedAddress = (): Promise<boolean> => {
    if (resolvingRef.current) return resolvingRef.current
    const input = (inputRef.current?.value ?? "").trim()

    const run = async (): Promise<boolean> => {
      if (!input) { askToTap(EMPTY_MESSAGE); return false }
      if (!window.google?.maps?.places) { askToTap(TAP_MESSAGE); return false }
      try {
        const sessionToken = new google.maps.places.AutocompleteSessionToken()
        const prediction = await withTimeout(getTopPrediction(input, sessionToken), null)
        const place = prediction ? await withTimeout(getPlaceDetails(prediction.place_id, sessionToken), null) : null
        if (selectPlace(place)) return true
      } catch {}
      askToTap(TAP_MESSAGE)
      return false
    }

    resolvingRef.current = run().finally(() => { resolvingRef.current = null })
    return resolvingRef.current
  }

  useImperativeHandle(ref, () => ({ resolveTypedAddress }))

  const initAutocomplete = () => {
    if (!inputRef.current || !window.google?.maps?.places) return

    const autocompleteOptions: google.maps.places.AutocompleteOptions = {
      componentRestrictions: { country: "us" },
      types: ["address"],
      fields: PLACE_FIELDS,
    }
    if (searchBounds) {
      autocompleteOptions.bounds = new google.maps.LatLngBounds(
        { lat: searchBounds.south, lng: searchBounds.west },
        { lat: searchBounds.north, lng: searchBounds.east }
      )
      autocompleteOptions.strictBounds = true
    }
    autocompleteRef.current = new google.maps.places.Autocomplete(inputRef.current, autocompleteOptions)

    autocompleteRef.current.addListener("place_changed", () => {
      const place = autocompleteRef.current?.getPlace()
      if (place?.formatted_address) {
        selectPlace(place)
      } else if (place) {
        // Enter pressed without choosing a suggestion: Google hands back only the typed text.
        void resolveTypedAddress()
      }
    })
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return
    // A highlighted suggestion is Google's to select (place_changed fires).
    if (document.querySelector(".pac-container .pac-item-selected")) return
    e.preventDefault()
    void resolveTypedAddress()
  }

  const [isFocused, setIsFocused] = useState(false)

  return (
    <div className={`relative ${className || ""}`}>
      {!value && !isFocused && (
        <div className="absolute -inset-1 rounded-2xl bg-[#0891b2]/20 animate-pulse" />
      )}
      <div className="relative">
        <div className="absolute left-3 top-1/2 -translate-y-1/2 z-10">
          <MapPin className="h-5 w-5 text-[#0891b2]" />
        </div>
        <Input
          ref={inputRef}
          type="text"
          enterKeyHint="go"
          placeholder={placeholder}
          value={value}
          onChange={(e) => { setHint(""); onChange(e.target.value) }}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          aria-invalid={hint ? true : undefined}
          className="h-16 pl-10 rounded-xl border-2 border-[#0891b2]/50 bg-white text-lg text-gray-900 placeholder:text-gray-400 focus:border-[#0891b2] focus:ring-[#0891b2]/20"
        />
        {!isLoaded && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-200 border-t-[#0891b2]" />
          </div>
        )}
      </div>
      {hint && (
        <p role="alert" className="relative mt-2 text-center text-sm font-medium" style={{ color: "#dc2626" }}>
          {hint}
        </p>
      )}
    </div>
  )
})
