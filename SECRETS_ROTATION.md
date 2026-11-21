# Secrets Rotation Guide

## 🔒 Generating Secure Secrets

### JWT Secrets (Required)
```bash
# Generate 32+ character random hex strings
openssl rand -hex 32  # Copy output to JWT_ACCESS_SECRET
openssl rand -hex 32  # Copy output to JWT_REFRESH_SECRET
```

**Current approach (❌ unsafe):**
- Secrets in .env file (even with .gitignore, risk of accidental commits)
- Weak placeholder values in development

**Production approach (✅ secure):**
1. Never commit real secrets to git
2. Store secrets in environment variables via:
   - **Docker Compose:** Use `.env.prod` (not in git)
   - **Kubernetes:** Use Secrets objects
   - **AWS:** Use Secrets Manager or Parameter Store
   - **Azure:** Use Key Vault
   - **Local dev:** Use `.env.local` (not in git)

## Admin Password Change Flow

The admin user is seeded with a temporary password. They MUST change it on first login.

**To enforce this:**

1. Add `mustChangePassword` flag to User model (see FIX #3: Database migration)
2. Add middleware that blocks all requests except `/users/change-password` if flag is true
3. After successful password change, set flag to false

```bash
# After deployment to production:
1. Admin receives temporary password from deployment team
2. Admin logs in
3. System forces password change before accessing any features
4. Temporary password is invalidated
```

## Rotation Schedule

| Secret | Rotation | Trigger |
|--------|----------|---------|
| JWT Access Secret | Every 90 days | Scheduled |
| JWT Refresh Secret | Every 180 days | Scheduled |
| Database Password | Every 6 months | Scheduled |
| API Keys (Stripe, etc) | Every 12 months | Scheduled |
| Credentials | Immediately | If compromised |

## Rotation Process

1. Generate new secret: `openssl rand -hex 32`
2. Add to vault/secrets manager
3. Deploy with both old and new secrets (for grace period)
4. After 1 hour, disable old secret
5. After 24 hours, remove old secret

## Checklist Before Production

- [ ] All secrets are environment variables (not in .env)
- [ ] .env is in .gitignore (verified with `git check-ignore .env`)
- [ ] No hardcoded secrets in source code
- [ ] Admin account password is temporary (forces change on login)
- [ ] All .env files removed from git history (use `git filter-branch` if needed)
- [ ] Secure secrets vault is configured (AWS/Azure/etc)
- [ ] Team members have access to secrets vault
- [ ] Secrets are rotated on schedule

## Commands to Verify Security

```bash
# Check if .env is tracked by git
git ls-files | grep -E '\.env'
# Should output nothing (if .env is in .gitignore)

# Check for hardcoded secrets
grep -r "sk_" src/  # Should find nothing
grep -r "password" src/ | grep -v "passwordHash" | grep -v "PASSWORD"
# Should find no actual passwords

# Verify git history (after removing .env)
git log --all --full-history -- .env
# Should show no commits modifying .env
```
