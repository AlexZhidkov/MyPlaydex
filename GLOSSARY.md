# MyPlaydex

A global discovery platform for social sports, cultural performances, family activities, and community gatherings, launching initially across Greater Perth, Western Australia.

## Language

**Activity**:
Any scheduled, in-person social, recreational, cultural, or sporting gathering that people can attend.
_Avoid_: Event, Gig, Happening

**Organizer**:
The club, association, promoter, business, or group that hosts and organizes activities.
_Avoid_: Club, Organization, Host, Vendor, Provider

**Venue**:
The physical location (park, court, leisure centre, hall, theatre, stadium) where an activity takes place, with geo-coordinates.
_Avoid_: Place, Facility, Ground

**Region**:
A distinct geographical metropolitan area or administrative territory used to partition listings and queries.
_Avoid_: City, Area, Market

**Listing**:
The published discovery record on the platform representing an Activity, Organizer, or Venue, with geo-coordinates and an optional external referral link.
_Avoid_: Post, Entry, Ad, Submission

**Unverified Listing**:
A published Listing whose external referral link is missing or unreachable, surfaced for location discovery without an outbound referral action.
_Avoid_: Broken Listing, Dead Listing, Draft

**Unreviewed Listing**:
A published Activity or Organizer Listing created by an automated crawler, linked with an uncertain or missing Venue or Organizer match, or flagged as a borderline duplicate Activity candidate awaiting human curation.
_Avoid_: Draft, Unverified Listing, Pending Approval, Flagged Record

**Expired Activity**:
A non-recurring Activity whose scheduled end date (or start date) has passed the retention grace window in AWST and is eligible for database purge.
_Avoid_: Past Event, Old Record, Dead Activity

**Source Reference**:
An external platform listing (such as an Eventbrite, Humanitix, Meetup, Facebook, council, major venue website, organizer website, or PDF timetable page) linked to a canonical Activity for referral and re-crawl idempotency.
_Avoid_: Mirror, Alias, External Copy, Child Listing

**Admin**:
An authenticated platform operator authorized to verify, edit, and remove published Listings.
_Avoid_: Curator, Moderator, Staff
