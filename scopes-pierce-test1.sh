# Client of the pierce-loyalty-giftcard-test1 deployment (CTP_CLIENT_ID / CTP_CLIENT_SECRET):
# processor at runtime plus postDeploy / preUndeploy.
RUNTIME_SCOPES=(
  manage_orders
  view_customers
  view_sessions
  view_api_clients
  introspect_oauth_tokens
  manage_checkout_payment_intents
  manage_types
  manage_cart_discounts
  manage_extensions
)

# Client of scripts/ct-connector.mjs (just CONNECT_ENV=test1 connector-status / connector-publish / deploy / redeploy / retunnel).
# The *_checkout_payment_integrations scopes are only needed by retunnel.
DEPLOY_SCOPES=(
  manage_connectors
  manage_connectors_deployments
  view_connectors
  view_connectors_deployments
  manage_checkout_payment_integrations
  view_checkout_payment_integrations
)
