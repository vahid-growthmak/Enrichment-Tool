export function serializeProfile(p) {
    return {
        id: p.id,
        linkedinUrl: p.linkedin_url,
        linkedinSlug: p.linkedin_slug,
        linkedinKind: p.linkedin_kind,
        firstName: p.first_name,
        lastName: p.last_name,
        fullName: p.full_name,
        headline: p.headline,
        jobTitle: p.job_title,
        seniority: p.seniority,
        photoUrl: p.photo_url,
        company: {
            name: p.company_name,
            domain: p.company_domain,
            website: p.company_website,
            linkedinUrl: p.company_linkedin_url,
            industry: p.company_industry,
            size: p.company_size,
        },
        location: { city: p.city, state: p.state, country: p.country, countryIso: p.country_iso },
        mobile: p.mobile_number
            ? {
                number: p.mobile_number,
                countryCode: p.mobile_country_code,
                countryIso: p.mobile_country_iso,
                lineType: p.mobile_line_type,
                source: p.mobile_source,
                foundAt: p.mobile_found_at,
            }
            : null,
        workEmail: p.work_email,
        workEmailStatus: p.work_email_status,
        personalEmail: p.personal_email,
        status: p.enrichment_status,
        source: p.enrichment_source,
        lastEnrichedAt: p.last_enriched_at,
        lastAttemptAt: p.last_attempt_at,
        attemptCount: p.attempt_count,
        lastError: p.last_error,
        inProgress: p.enrichment_status === "in_progress",
        createdAt: p.created_at,
        updatedAt: p.updated_at,
    };
}
export function serializePhone(ph) {
    return {
        id: ph.id,
        number: ph.number_e164,
        countryCode: ph.country_code,
        countryIso: ph.country_iso,
        lineType: ph.line_type,
        isMobile: ph.is_mobile,
        provider: ph.provider,
        providerType: ph.provider_type,
        providerStatus: ph.provider_status,
        createdAt: ph.created_at,
    };
}
export function serializeEmail(e) {
    return { id: e.id, email: e.email, kind: e.kind, status: e.status, provider: e.provider, createdAt: e.created_at };
}
export function serializeAttempt(a) {
    return {
        id: a.id,
        provider: a.provider,
        status: a.status,
        outcome: a.outcome,
        phonesFound: a.phones_found,
        emailsFound: a.emails_found,
        creditsUsed: a.credits_used,
        errorCode: a.error_code,
        errorMessage: a.error_message,
        pollCount: a.poll_count,
        externalRequestId: a.external_request_id,
        submittedAt: a.submitted_at,
        completedAt: a.completed_at,
    };
}
export function serializeBatch(b) {
    const processed = b.processed_count;
    const attempted = processed - b.invalid_count - b.duplicate_count - b.cancelled_count;
    return {
        id: b.id,
        name: b.name,
        fileName: b.file_name,
        createdBy: b.created_by,
        status: b.status,
        total: b.total_rows,
        queued: b.queued_rows,
        processed,
        foundMobile: b.mobile_found_count,
        mobileMissing: b.mobile_missing_count,
        cached: b.cached_count,
        invalid: b.invalid_count,
        duplicate: b.duplicate_count,
        failed: b.failed_count,
        cancelled: b.cancelled_count,
        hitRate: attempted > 0 ? b.mobile_found_count / attempted : null,
        columnMapping: b.column_mapping,
        sourceHeaders: b.source_headers,
        createdAt: b.created_at,
        startedAt: b.started_at,
        completedAt: b.completed_at,
        updatedAt: b.updated_at,
    };
}
export function serializeBatchItem(i) {
    return {
        id: i.id,
        rowNumber: i.row_number,
        inputUrl: i.input_url,
        inputFirstName: i.input_first_name,
        inputLastName: i.input_last_name,
        inputCompany: i.input_company,
        profileId: i.profile_id,
        status: i.status,
        source: i.result_source,
        error: i.error,
        duplicateOfRow: i.duplicate_of_row,
        completedAt: i.completed_at,
        profile: i.profile_id
            ? {
                linkedinUrl: i.linkedin_url ?? null,
                fullName: i.full_name ?? null,
                firstName: i.first_name ?? null,
                lastName: i.last_name ?? null,
                jobTitle: i.job_title ?? null,
                companyName: i.company_name ?? null,
                workEmail: i.work_email ?? null,
                mobile: i.mobile_number ? { number: i.mobile_number, countryCode: i.mobile_country_code ?? null, countryIso: i.mobile_country_iso ?? null } : null,
            }
            : null,
    };
}
//# sourceMappingURL=serializers.js.map