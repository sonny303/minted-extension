# Web-fillable token catalog (snapshot)

Snapshot of the tokens a **web** fill can resolve — the families in
`WEB_FILL_FAMILIES` (`mintedpanel/src/lib/fillTokenReach.ts`). The live
catalog is schema-derived (`get_sop_field_tokens()` sweeps the columns of
`providers`, `provider_groups`, `facilities`, `state_licenses`,
`provider_facility_assignments`, `group_insurance_policies` and camelCases
them), plus composed tokens and the user/contact families.

**Regenerate** when a migration adds a column: re-derive from
`mintedpanel/supabase/migrations` (column sweep, minus `id, org_id,
created_at, updated_at, *_id, status, is_active, is_new_grad`). Internal
bookkeeping columns (`launchId`, `referenceOnly`, `verificationState`,
`statusId`, `license.verified*`) are left out on purpose — no payer asks for
them. `formCaptures.test.ts` reads this file: a suggestion outside it fails.

A stale snapshot costs a wrong *suggestion*, never a wrong fill — the trainer
approves from the live picker.

## provider — the practitioner
`provider.firstName` `provider.lastName` `provider.middleInitial` `provider.suffix`
`provider.fullName` `provider.lastFirst` `provider.fullNameWithCredentials`
`provider.credentials` `provider.degree` `provider.dateOfBirth` `provider.gender`
`provider.ethnicity` `provider.languages` `provider.ssnLast4`
`provider.email` `provider.phone`
`provider.homeStreet` `provider.homeCity` `provider.homeState` `provider.homeZip`
`provider.npi` `provider.caqhId` `provider.caqhLastAttestedDate`
`provider.deaNumber` `provider.deaExpirationDate` `provider.taxonomyCode`
`provider.specialty` `provider.subSpecialty` `provider.boardCertified`
`provider.additionalCertifications` `provider.ageGroupsServed`
`provider.startDate` `provider.terminatedDate`
`provider.schoolName` `provider.graduationDate`
`provider.malpracticeCarrier` `provider.malpracticePolicyNumber`
`provider.malpracticeCoverageStart` `provider.malpracticeCoverageEnd`
`provider.licenseNumber` `provider.licenseState` `provider.licenseIssueDate`
`provider.licenseExpirationDate`
`provider.medicaidAttested` `provider.culturalCompetencyTraining`

## license — the state license matching the case state (prefer over provider.license*)
`license.state` `license.licenseNumber` `license.licenseType` `license.issueDate`
`license.expirationDate`

## group — the billing entity / practice (TIN holder)
`group.name` `group.tin` `group.taxIdType` `group.npiType2` `group.states`
`group.websiteUrl` `group.preferredContactMethod`
`group.billingStreet` `group.billingSuite` `group.billingCity` `group.billingState`
`group.billingZip` `group.billingContactName` `group.billingPhone` `group.billingFax`
`group.billingEmail`
`group.correspondenceStreet` `group.correspondenceSuite` `group.correspondenceCity`
`group.correspondenceState` `group.correspondenceZip`
`group.correspondenceContactName` `group.correspondencePhone`
`group.correspondenceFax` `group.correspondenceEmail`
`group.credentialingStreet` `group.credentialingSuite` `group.credentialingCity`
`group.credentialingState` `group.credentialingZip`
`group.credentialingContactName` `group.credentialingPhone`
`group.credentialingFax` `group.credentialingEmail`
`group.contractingContactName` `group.contractingContactTitle`
`group.contractingContactEmail` `group.contractSignerName` `group.contractSignerEmail`

## facility — the practice / service location the fill targets
`facility.name` `facility.address` `facility.street` `facility.suite`
`facility.city` `facility.state` `facility.zip` `facility.county`
`facility.phone` `facility.fax` `facility.email` `facility.appointmentPhone`
`facility.contactName` `facility.acceptingNewPatients` `facility.languageLine`
`facility.languagesOffered` `facility.interpreterLanguages` `facility.hours`
`facility.adaCompliance` `facility.serviceTypes` `facility.treatingCategories`
`facility.effectiveDate`

## assignment — this provider at this facility
`assignment.isPrimary` `assignment.startDate` `assignment.practiceFrequency`

## groupInsurance — the group's liability policy
`groupInsurance.insuranceType` `groupInsurance.insurerName`
`groupInsurance.policyNumber` `groupInsurance.policyStartDate`
`groupInsurance.policyEndDate`

## user — the coordinator filling the form ("submitted by", "your name")
`user.name` `user.firstName` `user.lastName` `user.title` `user.email`

## Org default contacts — billingContact / credentialingContact / contractingSigner
Each role carries the same fields:
`credentialingContact.firstName` `credentialingContact.lastName`
`credentialingContact.fullName` `credentialingContact.title`
`credentialingContact.email` `credentialingContact.phoneOffice`
`credentialingContact.phoneExtension` `credentialingContact.phoneMobile`
`credentialingContact.fax` `credentialingContact.addressLine1`
`credentialingContact.addressLine2` `credentialingContact.city`
`credentialingContact.state` `credentialingContact.postalCode`
`credentialingContact.country`
`billingContact.firstName` `billingContact.lastName` `billingContact.fullName`
`billingContact.title` `billingContact.email` `billingContact.phoneOffice`
`billingContact.phoneExtension` `billingContact.phoneMobile` `billingContact.fax`
`billingContact.addressLine1` `billingContact.addressLine2` `billingContact.city`
`billingContact.state` `billingContact.postalCode` `billingContact.country`
`contractingSigner.firstName` `contractingSigner.lastName`
`contractingSigner.fullName` `contractingSigner.title` `contractingSigner.email`
`contractingSigner.phoneOffice` `contractingSigner.phoneExtension`
`contractingSigner.phoneMobile` `contractingSigner.fax`
`contractingSigner.addressLine1` `contractingSigner.addressLine2`
`contractingSigner.city` `contractingSigner.state` `contractingSigner.postalCode`
`contractingSigner.country`

## Never suggest
`payer.*`, `contract.*`, `mso.*` — case-scoped; no fill resolves them
(`UNFILLABLE_FAMILIES`). A form question about the payer itself is `human` or
`fixed`.
