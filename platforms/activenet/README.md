# ActiveNet platform

The connector uses one anonymous `GET` per calendar read and one anonymous
`GET` for identity verification. Calendar requests use
`{origin}{basePath}/rest/reservation/resource/availability/daily/{court}` with
the ordered query `start_date`, `end_date`, `customer_id=0`, `company_id=0`,
`locale=en-US`. Detail requests use
`{origin}{basePath}/rest/reservation/resource/detail/{court}` with no query.
Both send only `accept: application/json`; transport, pacing and the per-read
lease belong to the injected runtime.

The tenant supplies its origin, one-segment `basePath` and IANA time zone.
Court keys are numeric strings from 1 to 10 digits. Each read accepts an
inclusive range of one through seven valid local dates.

## Calendar rules

Statuses 0 and 1 use the returned times. Status 2 with an empty times array is
a complete schedule-closed day; status 4 with an empty array is a complete
fully-booked day. Status 7 with an empty array is hidden with unknown
occupancy. Other statuses are unknown and unusable. Check-in-only and
check-out-only modes are unsupported and unusable. Unknown provider fields are
removed from `sanitized`.

Intervals must use zero-padded `HH:mm:ss`, have a positive duration, and not
overlap. Touching intervals are allowed. `is_cross_day` is rejected. An
interval with a nonzero start and exactly `00:00:00` end closes at the next
local midnight and receives `source_closes_at_midnight`; other backwards or
zero-length intervals are invalid. Wall times are converted with the tenant's
time zone; nonexistent and ambiguous local times fail with `unsupported_time`.

A range is complete only when every expected date appears exactly once and
every row has a recognized complete shape. Missing, duplicate, out-of-range or
unknown-status rows make returned days unusable and append the documented
coverage reasons. Source rows and their times remain in provider order in the
sanitized shape:

```json
{
  "resource_id": 900001,
  "daily_details": [
    {
      "date": "2026-01-02",
      "status": 0,
      "check_in_only": false,
      "check_out_only": false,
      "times": [
        {
          "available": true,
          "start_time": "09:00:00",
          "end_time": "11:00:00",
          "is_cross_day": false
        }
      ]
    }
  ]
}
```

The parser identity is `iparcs-anonymous` / `iparcs-1.2` /
`iparcs-calendar-v1`. Access result codes `0002`, `0006`, `0007`, `0009`,
`0010`, `0011`, `0012` and `0021` map to `access_blocked`; only `0000` and
`0001` are success envelopes. The stable reason codes are
`source_hidden_or_unavailable`, `occupancy_unknown`, `source_schedule_closed`,
`source_fully_booked`, `source_closes_at_midnight`, `unknown_source_status`,
`unsupported_check_mode`, `duplicate_source_date`, `date_out_of_range`,
`date_coverage_incomplete` and `range_incomplete`.

The synthetic tests in this folder port the parser cases from the CourtTide
adapter tests. Their tenant, court IDs, labels, URLs and payloads are invented.
